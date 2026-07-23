/**
 * WebSocket adapter for the {@link RealtimeConnection} port.
 *
 * Wraps the browser's native {@link WebSocket} API. Reconnects automatically on
 * non-client-initiated closes using the provided backoff strategy. Incoming
 * text frames are dispatched to 'message' subscribers; frames that parse as a
 * JSON envelope `{ event: string, data: unknown }` are additionally dispatched
 * to subscribers for that specific event name.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { ExponentialBackoff } from './exponential-backoff';
import { RealtimeError } from './realtime-error';
import { runReconnect } from './reconnect';
import type {
    RealtimeConnection,
    RealtimeMessage,
    RealtimeMessageHandler,
    RealtimeState,
    RealtimeStateHandler,
} from './realtime-connection';

/**
 * Injectable factory for {@link WebSocket} instances.
 *
 * @param url - the WebSocket endpoint URL
 * @param protocols - optional subprotocol(s)
 * @returns a new WebSocket
 */
export type WebSocketFactory = (url: string, protocols?: string | readonly string[]) => WebSocket;

/** Construction options for {@link WebSocketConnection}. */
export interface WebSocketConnectionOptions {
    /** The WebSocket endpoint URL, or a function that returns it. The function form is called on every `connect()`, enabling per-connect auth tokens in the query string. */
    readonly url: string | (() => string);

    /** Optional WebSocket subprotocol(s) forwarded to the constructor. */
    readonly protocols?: string | readonly string[];

    /** Backoff strategy for reconnects. Defaults to `new ExponentialBackoff()`. */
    readonly backoff?: ExponentialBackoff;

    /** Override the WebSocket constructor. Defaults to `(url, protocols) => new WebSocket(url, protocols)`. */
    readonly webSocketFactory?: WebSocketFactory;

    /** Awaited after the backoff delay fires and before each reconnect attempt opens a new WebSocket. Never called for the initial `connect()` or a manual `connect()` call. Wire the application's `TokenRefreshCoordinator` here so an expired token is refreshed before each reconnect, and pair it with the `url()` builder reading the fresh token; without this an expired-token connection retries forever with stale credentials. Rejection abandons the attempt and the next reconnect is scheduled through the existing backoff path. */
    readonly beforeReconnect?: () => Promise<void>;
}

/**
 * WebSocket adapter implementing {@link RealtimeConnection}.
 *
 * Reconnects automatically on non-client-initiated closes. All registered event
 * listeners are re-applied after every reconnect. Provides an additional
 * {@link WebSocketConnection.send} method for outbound messages. When
 * `beforeReconnect` is supplied, it is awaited before each reconnect opens a
 * new WebSocket.
 */
export class WebSocketConnection implements RealtimeConnection {
    /** The endpoint URL, or a factory returning it per connect. */
    readonly #url: string | (() => string);

    /** The WebSocket subprotocol(s), or undefined for none. */
    readonly #protocols: string | readonly string[] | undefined;

    /** The backoff strategy spacing reconnect attempts. */
    readonly #backoff: ExponentialBackoff;

    /** The factory that constructs each WebSocket. */
    readonly #factory: WebSocketFactory;

    /** Optional hook awaited before each reconnect. */
    readonly #beforeReconnect: (() => Promise<void>) | undefined;

    /** Registered message handlers, keyed by event name. */
    readonly #messageHandlers: Map<string, Set<RealtimeMessageHandler>> = new Map();

    /** Registered connection-state change handlers. */
    readonly #stateHandlers: Set<RealtimeStateHandler> = new Set();

    /** The active WebSocket, or null when not open. */
    #socket: WebSocket | null = null;

    /** The current connection lifecycle state. */
    #state: RealtimeState = 'idle';

    /** The current zero-based reconnect attempt counter. */
    #attempt: number = 0;

    /** The pending reconnect timer, or null when none. */
    #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Construct a new WebSocket connection.
     *
     * @param options - URL, protocols, backoff strategy, and optional WebSocket
     * factory
     */
    constructor(options: WebSocketConnectionOptions) {
        this.#url = options.url;
        this.#protocols = options.protocols;
        this.#backoff = options.backoff ?? new ExponentialBackoff();
        this.#factory = options.webSocketFactory ?? defaultWebSocketFactory;
        this.#beforeReconnect = options.beforeReconnect;
    }

    /**
     * The current connection lifecycle state.
     */
    get state(): RealtimeState {
        return this.#state;
    }

    /**
     * Open the WebSocket connection. No-op when already connecting or open.
     */
    connect(): void {
        if (this.#state === 'connecting' || this.#state === 'open') {
            return;
        }

        this.#openSocket();
    }

    /**
     * Close the connection permanently, cancelling any pending reconnect.
     */
    disconnect(): void {
        this.#cancelReconnect();
        this.#closeSocket();
        this.#setState('closed');
    }

    /**
     * Subscribe to messages for a specific event name.
     *
     * To receive all frames use the event name `'message'`. Frames that parse
     * as a JSON envelope are also dispatched to their named event subscribers.
     *
     * @param event - the event name to subscribe to
     * @param handler - called for each matching incoming message
     * @returns an unsubscribe function
     */
    on(event: string, handler: RealtimeMessageHandler): () => void {
        let handlers = this.#messageHandlers.get(event);

        if (handlers === undefined) {
            handlers = new Set();
            this.#messageHandlers.set(event, handlers);
        }

        handlers.add(handler);

        return () => {
            this.#messageHandlers.get(event)?.delete(handler);
        };
    }

    /**
     * Subscribe to connection state changes.
     *
     * @param handler - called each time the state transitions
     * @returns an unsubscribe function
     */
    onStateChange(handler: RealtimeStateHandler): () => void {
        this.#stateHandlers.add(handler);

        return () => {
            this.#stateHandlers.delete(handler);
        };
    }

    /**
     * Send a text frame over the open socket.
     *
     * @param data - the raw text to send
     * @throws {@link RealtimeError} when the socket is not in the open state
     */
    send(data: string): void {
        if (this.#socket === null || this.#state !== 'open') {
            throw new RealtimeError('Cannot send: WebSocket is not open.');
        }

        this.#socket.send(data);
    }

    /**
     * Open a fresh WebSocket and wire its lifecycle handlers.
     */
    #openSocket(): void {
        this.#setState('connecting');

        const url = typeof this.#url === 'function' ? this.#url() : this.#url;
        const socket = this.#factory(url, this.#protocols);

        socket.onopen = () => {
            this.#attempt = 0;
            this.#setState('open');
        };

        socket.onmessage = (event: MessageEvent) => {
            this.#dispatchFrame(String(event.data));
        };

        socket.onclose = () => {
            this.#socket = null;
            this.#scheduleReconnect();
        };

        this.#socket = socket;
    }

    /**
     * Deliver a raw frame to `'message'` subscribers, and additionally to the
     * named-event subscribers when it parses as a JSON envelope.
     *
     * @param raw - the raw text frame received from the socket
     */
    #dispatchFrame(raw: string): void {
        this.#deliverToHandlers('message', { event: 'message', data: raw });

        const envelope = tryParseEnvelope(raw);

        if (envelope !== null && envelope.event !== 'message') {
            this.#deliverToHandlers(envelope.event, { event: envelope.event, data: envelope.data });
        }
    }

    /**
     * Fan a message out to every handler registered for `event`.
     *
     * @param event - the event name whose handlers receive the message
     * @param message - the message delivered to each handler
     */
    #deliverToHandlers(event: string, message: RealtimeMessage): void {
        const handlers = this.#messageHandlers.get(event);

        if (handlers === undefined) {
            return;
        }

        for (const handler of handlers) {
            handler(message);
        }
    }

    /**
     * Enter the connecting state and schedule the next reconnect after the
     * backoff delay for the current attempt.
     */
    #scheduleReconnect(): void {
        const delay = this.#backoff.delayFor(this.#attempt++);

        this.#setState('connecting');

        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null;
            void this.#runReconnect();
        }, delay);
    }

    /**
     * Run one reconnect attempt, awaiting the optional beforeReconnect hook
     * first. A disconnect that lands while the hook is pending must leave no
     * trace once it settles, so the closed state is re-checked afterwards.
     */
    async #runReconnect(): Promise<void> {
        await runReconnect({
            beforeReconnect: this.#beforeReconnect,
            isClosed: () => this.#state === 'closed',
            reopen: () => this.#openSocket(),
            reschedule: () => this.#scheduleReconnect(),
        });
    }

    /**
     * Detach the lifecycle handlers from the active socket and close it.
     */
    #closeSocket(): void {
        if (this.#socket !== null) {
            this.#socket.onopen = null;
            this.#socket.onmessage = null;
            this.#socket.onclose = null;
            this.#socket.close();
            this.#socket = null;
        }
    }

    /**
     * Cancel any pending reconnect timer.
     */
    #cancelReconnect(): void {
        if (this.#reconnectTimer !== null) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
    }

    /**
     * Transition to `next`, notifying state subscribers only on a real change.
     *
     * @param next - the state to transition to
     */
    #setState(next: RealtimeState): void {
        if (this.#state === next) {
            return;
        }

        this.#state = next;

        for (const handler of this.#stateHandlers) {
            handler(next);
        }
    }
}

/**
 * Default WebSocket factory used when no override is provided.
 *
 * Spreads `readonly string[]` protocols into a mutable copy so the DOM
 * `WebSocket` constructor, which requires `string[]`, accepts the value.
 *
 * @param url - the WebSocket endpoint URL
 * @param protocols - optional subprotocol(s)
 * @returns a new WebSocket
 */
function defaultWebSocketFactory(url: string, protocols?: string | readonly string[]): WebSocket {
    if (protocols === undefined) {
        return new WebSocket(url);
    }

    if (typeof protocols === 'string') {
        return new WebSocket(url, protocols);
    }

    return new WebSocket(url, protocols as string[]);
}

/**
 * Report whether a parsed value has the envelope shape: an object carrying a
 * string `event` and a `data` field.
 *
 * @param value - the value parsed from a raw frame
 * @returns true when the value can be read as an event envelope
 */
function isEnvelopeShape(value: unknown): value is {
    /** The event name the envelope declares. */
    event: string;

    /** The payload the envelope carries. */
    data: unknown;
} {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    if (!('event' in value) || !('data' in value)) {
        return false;
    }

    return typeof (value as Record<string, unknown>)['event'] === 'string';
}

/**
 * Attempt to parse a raw text frame as a typed event envelope.
 *
 * @param raw - the raw text frame to parse
 * @returns the envelope when the frame is valid JSON with `event` (string) and
 * `data` fields, otherwise `null`
 */
function tryParseEnvelope(raw: string): {
    /** The event name the envelope declares. */
    event: string;

    /** The payload text extracted from the envelope. */
    data: string;
} | null {
    try {
        const parsed: unknown = JSON.parse(raw);

        if (!isEnvelopeShape(parsed)) {
            return null;
        }

        const data = typeof parsed.data === 'string' ? parsed.data : JSON.stringify(parsed.data);

        return { event: parsed.event, data };
    } catch {
        return null;
    }
}
