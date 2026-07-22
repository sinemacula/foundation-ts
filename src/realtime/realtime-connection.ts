/**
 * Realtime connection port.
 *
 * Server push is a separate concern from request/response. This port sits
 * BESIDE {@link HttpClient}, not on top of it - it models a persistent,
 * server-initiated stream rather than a one-shot request. SSE and WebSocket are
 * the two production adapters; tests substitute an in-memory fake.
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
 *
 * @param message - the received message
 */
export type RealtimeMessageHandler = (message: RealtimeMessage) => void;

/**
 * Notified whenever the connection transitions to a new state.
 *
 * @param state - the new connection state
 */
export type RealtimeStateHandler = (state: RealtimeState) => void;

/**
 * A transport-agnostic channel for server-pushed events.
 *
 * Implementations must be injectable so that product modules never couple
 * themselves to a concrete transport.
 */
export interface RealtimeConnection {
    /** The current connection lifecycle state. */
    readonly state: RealtimeState;

    /**
     * Open the connection. No-op when already connecting or open.
     */
    connect(): void;

    /**
     * Close the connection permanently and cancel any pending reconnect.
     */
    disconnect(): void;

    /**
     * Subscribe to messages for a specific event name.
     *
     * @param event - the event name to subscribe to
     * @param handler - called for each matching incoming message
     * @returns an unsubscribe function; calling it stops further delivery
     */
    on(event: string, handler: RealtimeMessageHandler): () => void;

    /**
     * Subscribe to connection state changes.
     *
     * @param handler - called each time the state transitions
     * @returns an unsubscribe function; calling it stops further delivery
     */
    onStateChange(handler: RealtimeStateHandler): () => void;
}
