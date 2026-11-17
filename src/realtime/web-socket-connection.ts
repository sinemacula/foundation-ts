/**
 * WebSocket adapter for the {@link RealtimeConnection} port.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { ExponentialBackoff } from './exponential-backoff';
import { RealtimeError } from './realtime-error';
import { type BeforeReconnectHook, runReconnect } from './reconnect';
import type {
    RealtimeConnection,
    RealtimeMessage,
    RealtimeMessageHandler,
    RealtimeState,
    RealtimeStateHandler,
} from './realtime-connection';

/**
 * Injectable factory for {@link WebSocket} instances.
 */
export type WebSocketFactory = (url: string, protocols?: string | readonly string[]) => WebSocket;

/** Construction options for {@link WebSocketConnection}. */
export interface WebSocketConnectionOptions {
    /** The endpoint URL, or a builder called on every open (reconnects included), for example to embed a fresh token. */
    readonly url: string | (() => string);

    /** Optional WebSocket subprotocol(s) forwarded to the constructor. */
    readonly protocols?: string | readonly string[];

    /** Backoff strategy for reconnects. Defaults to `new ExponentialBackoff()`. */
    readonly backoff?: ExponentialBackoff;

    /** Override the WebSocket constructor. Defaults to the platform global. */
    readonly webSocketFactory?: WebSocketFactory;

    /** Awaited before each reconnect, never before a manual `connect()`; pair it with a `url()` builder that reads the fresh token. */
    readonly beforeReconnect?: BeforeReconnectHook;

    /** Receives errors from throwing subscribers and failed reconnect opens, which are never thrown. */
    readonly onError?: (error: unknown) => void;
}

/**
 * WebSocket adapter implementing {@link RealtimeConnection}, with an extra
 * {@link WebSocketConnection.send} for outbound frames.
 *
 * Reconnects with backoff whenever the socket closes without a `disconnect()`;
 * subscriptions survive reconnects. Every text frame goes to `'message'`
 * subscribers, and a frame that parses as a `{ event, data }` JSON envelope
 * also goes to that event's subscribers, with non-string `data` as JSON.
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
    readonly #beforeReconnect: BeforeReconnectHook | undefined;

    /** The optional sink for errors the connection contains. */
    readonly #onError: ((error: unknown) => void) | undefined;

    /** Registered message handlers, keyed by event name. */
    readonly #messageHandlers: Map<string, Set<RealtimeMessageHandler>> = new Map();

    /** Registered connection-state change handlers. */
    readonly #stateHandlers: Set<RealtimeStateHandler> = new Set();

    /** The owned WebSocket, or null when there is none. */
    #socket: WebSocket | null = null;

    /** The current connection lifecycle state. */
    #state: RealtimeState = 'idle';

    /** The current zero-based reconnect attempt counter. */
    #attempt: number = 0;

    /** The pending reconnect timer, or undefined when none. */
    #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    /** Advanced on every disconnect so a superseded reconnect attempt abandons itself. */
    #generation: number = 0;

    /**
     * Construct a new WebSocket connection.
     */
    constructor(options: WebSocketConnectionOptions) {
        this.#url = options.url;
        this.#protocols = options.protocols;
        this.#backoff = options.backoff ?? new ExponentialBackoff();
        this.#factory = options.webSocketFactory ?? defaultWebSocketFactory;
        this.#beforeReconnect = options.beforeReconnect;
        this.#onError = options.onError;
    }

    /**
     * The current connection lifecycle state.
     */
    get state(): RealtimeState {
        return this.#state;
    }

    /**
     * Open the WebSocket connection. No-op when already connecting or open.
     *
     * @throws {@link RealtimeError} when the `url()` builder or socket factory
     * throws; the state is left unchanged and the original error is the cause
     */
    connect(): void {
        if (this.#state === 'connecting' || this.#state === 'open') {
            return;
        }

        try {
            this.#openSocket();
        } catch (error) {
            throw new RealtimeError('Cannot connect: the WebSocket could not be opened.', { cause: error });
        }
    }

    /**
     * Close the connection and cancel any pending reconnect until the next
     * `connect()`, which restarts the backoff.
     */
    disconnect(): void {
        this.#generation += 1;
        this.#attempt = 0;
        this.#cancelReconnect();
        this.#closeSocket();
        this.#setState('closed');
    }

    /**
     * Subscribe to messages for a specific event name; `'message'` receives
     * every raw frame.
     *
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
            handlers.delete(handler);
        };
    }

    /**
     * Subscribe to connection state changes.
     *
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
     * @throws {@link RealtimeError} when the socket is not in the open state
     */
    send(data: string): void {
        if (this.#socket === null || this.#state !== 'open') {
            throw new RealtimeError('Cannot send: WebSocket is not open.');
        }

        this.#socket.send(data);
    }

    /**
     * Open a fresh socket and own it before announcing `connecting`, so a
     * subscriber that disconnects in response closes it. A throwing `url()`
     * builder or factory leaves the state untouched.
     */
    #openSocket(): void {
        const url = typeof this.#url === 'function' ? this.#url() : this.#url;
        const socket = this.#factory(url, this.#protocols);

        socket.onopen = () => {
            if (this.#socket === socket) {
                this.#attempt = 0;
                this.#setState('open');
            }
        };

        socket.onmessage = (event: MessageEvent) => {
            if (this.#socket === socket) {
                this.#dispatchFrame(String(event.data));
            }
        };

        socket.onclose = () => {
            if (this.#socket === socket) {
                this.#socket = null;
                this.#scheduleReconnect();
            }
        };

        this.#socket = socket;
        this.#setState('connecting');
    }

    /**
     * Deliver a raw frame to `'message'` subscribers, and additionally to the
     * named-event subscribers when it parses as a JSON envelope.
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
     */
    #deliverToHandlers(event: string, message: RealtimeMessage): void {
        const handlers = this.#messageHandlers.get(event);

        if (handlers === undefined) {
            return;
        }

        for (const handler of handlers) {
            try {
                handler(message);
            } catch (error) {
                this.#report(error);
            }
        }
    }

    /**
     * Schedule the next reconnect after the backoff delay for the current
     * attempt, then enter the connecting state. The timer is stored first so a
     * subscriber that disconnects in response cancels it.
     */
    #scheduleReconnect(): void {
        const delay = this.#backoff.delayFor(this.#attempt++);

        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = undefined;
            void this.#runReconnect();
        }, delay);

        this.#setState('connecting');
    }

    /**
     * Run one reconnect attempt, abandoning it if a disconnect lands first.
     */
    async #runReconnect(): Promise<void> {
        const generation = this.#generation;

        await runReconnect({
            beforeReconnect: this.#beforeReconnect,
            isStale: () => this.#generation > generation,
            reopen: () => this.#openSocket(),
            reschedule: () => this.#scheduleReconnect(),
            onError: error => this.#report(error),
        });
    }

    /**
     * Pass a contained error to the `onError` sink, ignoring a throwing sink so
     * one failure never starves the remaining subscribers.
     */
    #report(error: unknown): void {
        try {
            this.#onError?.(error);
        } catch {
            // The sink is the last resort; nothing is left to report to.
        }
    }

    /**
     * Release the active socket and close it. Ownership goes first, so its
     * handlers ignore the close event and anything else it still delivers.
     */
    #closeSocket(): void {
        const socket = this.#socket;

        this.#socket = null;
        socket?.close();
    }

    /**
     * Cancel any pending reconnect timer.
     */
    #cancelReconnect(): void {
        clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = undefined;
    }

    /**
     * Transition to `next`, notifying state subscribers only on a real change.
     */
    #setState(next: RealtimeState): void {
        if (this.#state === next) {
            return;
        }

        this.#state = next;

        for (const handler of this.#stateHandlers) {
            try {
                handler(next);
            } catch (error) {
                this.#report(error);
            }
        }
    }
}

/**
 * Construct a platform WebSocket, omitting absent protocols because some
 * platforms treat an explicit `undefined` differently from no argument.
 */
function defaultWebSocketFactory(url: string, protocols?: string | readonly string[]): WebSocket {
    if (protocols === undefined) {
        return new WebSocket(url);
    }

    return new WebSocket(url, protocols as string | string[]);
}

/**
 * Report whether a parsed value is an object carrying a string `event` and a
 * `data` field.
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
 * Parse a raw frame as an event envelope, serialising non-string `data`.
 *
 * @returns the envelope, or `null` when the frame is not one
 */
function tryParseEnvelope(raw: string): {
    /** The event name the envelope declares. */
    event: string;

    /** The payload text extracted from the envelope. */
    data: string;
} | null {
    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    if (!isEnvelopeShape(parsed)) {
        return null;
    }

    const data = typeof parsed.data === 'string' ? parsed.data : JSON.stringify(parsed.data);

    return { event: parsed.event, data };
}
