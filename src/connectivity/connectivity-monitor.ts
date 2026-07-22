/**
 * Network-connectivity monitoring port.
 *
 * The reachability signal the kernel uses to pause pointless work while offline
 * - the update monitor pauses its polling and realtime connections pause
 * reconnect attempts rather than storming a network known to be down. Each
 * platform supplies an implementation (online/offline window events on web,
 * NetInfo on mobile); consumers depend only on this contract.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Invoked with the new connectivity state, once per actual change.
 */
export type ConnectivityHandler = (online: boolean) => void;

/**
 * Tracks network connectivity and notifies subscribers on change.
 */
export interface ConnectivityMonitor {
    /** The current connectivity state. */
    readonly online: boolean;

    /** Begin observing connectivity changes. A no-op when already started. */
    start(): void;

    /** Stop observing and detach listeners. A no-op when not started. */
    stop(): void;

    /**
     * Subscribe to connectivity changes.
     *
     * @param handler - invoked with the new state, once per actual change
     * @returns an unsubscribe function
     */
    onChange(handler: ConnectivityHandler): () => void;
}
