/**
 * Transport-agnostic port for server-pushed realtime events.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/** The lifecycle state of a realtime connection. */
export type RealtimeState = 'idle' | 'connecting' | 'open' | 'closed';

/** A single message delivered over the realtime channel. */
export interface RealtimeMessage {
    /** The name of the event the message carries. */
    readonly event: string;

    /** The message payload as text. */
    readonly data: string;
}

/**
 * Handles a single incoming realtime message.
 */
export type RealtimeMessageHandler = (message: RealtimeMessage) => void;

/**
 * Notified whenever the connection transitions to a new state.
 */
export type RealtimeStateHandler = (state: RealtimeState) => void;

/**
 * A transport-agnostic channel for server-pushed events.
 *
 * Every `on` and `onStateChange` call is its own registration: a handler
 * registered twice is called twice, and each unsubscribe removes only its own
 * registration. A delivery reaches the handlers registered when it starts,
 * skipping any removed meanwhile, and a throwing handler never starves the
 * rest.
 */
export interface RealtimeConnection {
    /** The current connection lifecycle state. */
    readonly state: RealtimeState;

    /**
     * Open the connection. No-op when already connecting or open.
     *
     * @throws {@link RealtimeError} when the transport cannot be opened; the
     * state is left unchanged and the original error is the cause
     */
    connect(): void;

    /**
     * Close the connection and cancel any pending reconnect until the next
     * `connect()`, which restarts the backoff. A message being delivered from
     * the released transport reaches no further handlers.
     */
    disconnect(): void;

    /**
     * Subscribe to messages for a specific event name.
     *
     * @returns a function that removes this registration
     */
    on(event: string, handler: RealtimeMessageHandler): () => void;

    /**
     * Subscribe to connection state changes.
     *
     * A transition made from inside a handler is delivered after the current
     * one, so each call records one transition in order and `state` may already
     * be later.
     *
     * @returns a function that removes this registration
     */
    onStateChange(handler: RealtimeStateHandler): () => void;
}
