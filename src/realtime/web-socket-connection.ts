/**
 * WebSocket adapter for the {@link RealtimeConnection} port.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { isRecord } from '../support/is-record';
import { clampTimerDelay } from '../support/timer';
import { ExponentialBackoff } from './exponential-backoff';
import { RealtimeError } from './realtime-error';
import { type BeforeReconnectHook, runReconnect, STABLE_CONNECTION_MS } from './reconnect';
import type {
    RealtimeConnection,
    RealtimeMessage,
    RealtimeMessageHandler,
    RealtimeState,
    RealtimeStateHandler,
} from './realtime-connection';
import { EventSubscribers, SubscriberList } from './subscribers';

/** `WebSocket.OPEN`, inlined so factories work where there is no global. */
const OPEN = 1;

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

    /** Backoff strategy for reconnects. Defaults to `new ExponentialBackoff({ jitter: 'equal' })`. */
    readonly backoff?: ExponentialBackoff;

    /** Override the WebSocket constructor. Defaults to the platform global; an injected one must report `readyState`. */
    readonly webSocketFactory?: WebSocketFactory;

    /** Awaited before each reconnect, never before a manual `connect()`; pair it with a `url()` builder that reads the fresh token. */
    readonly beforeReconnect?: BeforeReconnectHook;

    /** Receives errors the connection contains (throwing subscribers, failed reconnect opens, dropped binary frames). */
    readonly onError?: (error: unknown) => void;
}

/**
 * WebSocket adapter implementing {@link RealtimeConnection}, with an extra
 * {@link WebSocketConnection.send} for outbound frames.
 *
 * Reconnects with backoff whenever the socket closes or errors without a
 * `disconnect()`; subscriptions survive reconnects, and the backoff resets only
 * once a socket stays open for {@link STABLE_CONNECTION_MS}. Every text frame
 * goes to `'message'` subscribers, and a frame that parses as a
 * `{ event, data }` JSON envelope also goes to that event's subscribers, with
 * non-string `data` as JSON. Binary frames are dropped and reported to
 * `onError`.
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

    /** The sink for errors the connection contains. */
    readonly #onError: (error: unknown) => void;

    /** Registered message handlers, keyed by event name. */
    readonly #messages: EventSubscribers<RealtimeMessage> = new EventSubscribers(error => this.#report(error));

    /** Registered connection-state change handlers. */
    readonly #states: SubscriberList<RealtimeState> = new SubscriberList(error => this.#report(error));

    /** The owned WebSocket, or null when there is none. */
    #socket: WebSocket | null = null;

    /** The current connection lifecycle state. */
    #state: RealtimeState = 'idle';

    /** The current zero-based reconnect attempt counter. */
    #attempt: number = 0;

    /** When the owned socket counts as stable, or Infinity until it opens. */
    #stableAt: number = Number.POSITIVE_INFINITY;

    /** The pending reconnect timer, or undefined when none. */
    #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    /** Aborted by every disconnect, so a superseded reconnect attempt abandons itself. */
    #lifecycle: AbortController = new AbortController();

    /**
     * Construct a new WebSocket connection.
     */
    constructor(options: WebSocketConnectionOptions) {
        this.#url = options.url;
        this.#protocols = options.protocols;
        this.#backoff = options.backoff ?? new ExponentialBackoff({ jitter: 'equal' });
        this.#factory = options.webSocketFactory ?? defaultWebSocketFactory;
        this.#beforeReconnect = options.beforeReconnect;
        this.#onError = options.onError ?? ignoreError;
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
        const previous = this.#lifecycle;

        this.#lifecycle = new AbortController();
        this.#attempt = 0;
        this.#cancelReconnect();
        this.#release()?.close();
        this.#setState('closed');
        previous.abort();
    }

    /**
     * Subscribe to messages for a specific event name; `'message'` receives
     * every raw frame.
     *
     * @returns a function that removes this registration
     */
    on(event: string, handler: RealtimeMessageHandler): () => void {
        return this.#messages.on(event, handler);
    }

    /**
     * Subscribe to connection state changes.
     *
     * @returns a function that removes this registration
     */
    onStateChange(handler: RealtimeStateHandler): () => void {
        return this.#states.add(handler);
    }

    /**
     * Send a text frame over the open socket.
     *
     * @throws {@link RealtimeError} unless the connection is open and the
     * socket reports `OPEN`
     */
    send(data: string): void {
        if (this.#socket?.readyState !== OPEN || this.#state !== 'open') {
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
                this.#stableAt = performance.now() + STABLE_CONNECTION_MS;
                this.#setState('open');
            }
        };

        socket.onmessage = (event: MessageEvent) => {
            if (this.#socket === socket) {
                this.#dispatchFrame(socket, event.data);
            }
        };

        socket.onclose = () => this.#lose(socket);
        socket.onerror = () => this.#lose(socket);

        this.#socket = socket;
        this.#setState('connecting');
    }

    /**
     * Release an owned socket that closed or errored without a `disconnect()`,
     * close it in case only the error arrives, and schedule a reconnect.
     */
    #lose(socket: WebSocket): void {
        if (this.#socket !== socket) {
            return;
        }

        if (performance.now() >= this.#stableAt) {
            this.#attempt = 0;
        }

        this.#release();
        socket.close();
        this.#scheduleReconnect();
    }

    /**
     * Deliver a text frame to `'message'` subscribers, and to the named-event
     * subscribers when it parses as a JSON envelope. Both groups are captured
     * before either runs, and delivery stops once the socket is released.
     */
    #dispatchFrame(socket: WebSocket, data: unknown): void {
        if (typeof data !== 'string') {
            this.#report(new RealtimeError('Dropped a binary WebSocket frame: only text frames are supported.'));

            return;
        }

        const envelope = tryParseEnvelope(data);
        const deliveries = [this.#capture({ event: 'message', data })];

        if (envelope !== null && envelope.event !== 'message') {
            deliveries.push(this.#capture(envelope));
        }

        for (const deliver of deliveries) {
            deliver(() => this.#socket === socket);
        }
    }

    /**
     * Capture the current subscribers of a message's event for delivery.
     */
    #capture(message: RealtimeMessage): (isLive: () => boolean) => void {
        const deliver = this.#messages.snapshot(message.event);

        return isLive => deliver?.(message, isLive);
    }

    /**
     * Schedule the next reconnect after the backoff delay for the current
     * attempt, then enter the connecting state. The timer is stored first so a
     * subscriber that disconnects in response cancels it.
     */
    #scheduleReconnect(): void {
        const delay = clampTimerDelay(this.#backoff.delayFor(this.#attempt++));

        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = undefined;
            void runReconnect({
                beforeReconnect: this.#beforeReconnect,
                signal: this.#lifecycle.signal,
                reopen: () => this.#openSocket(),
                reschedule: () => this.#scheduleReconnect(),
                onError: error => this.#report(error),
            });
        }, delay);

        this.#setState('connecting');
    }

    /**
     * Pass a contained error to the `onError` sink, ignoring a throwing sink so
     * one failure never starves the remaining subscribers.
     */
    #report(error: unknown): void {
        try {
            this.#onError(error);
        } catch {
            // The sink is the last resort; nothing is left to report to.
        }
    }

    /**
     * Release ownership of the active socket, so its handlers ignore anything
     * it still delivers.
     *
     * @returns the released socket, or null when there was none
     */
    #release(): WebSocket | null {
        const socket = this.#socket;

        this.#socket = null;
        this.#stableAt = Number.POSITIVE_INFINITY;

        return socket;
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
        this.#states.emit(next);
    }
}

/**
 * The default error sink: contained errors are dropped.
 */
function ignoreError(): void {
    // Nothing to do without an application sink.
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
 * Parse a text frame as an `{ event, data }` envelope, serialising non-string
 * `data` as JSON.
 *
 * @returns the envelope's message, or `null` when the frame is not one
 */
function tryParseEnvelope(raw: string): RealtimeMessage | null {
    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    if (!isRecord(parsed) || !('data' in parsed)) {
        return null;
    }

    const { event, data } = parsed;

    if (typeof event !== 'string') {
        return null;
    }

    return { event, data: typeof data === 'string' ? data : JSON.stringify(data) };
}
