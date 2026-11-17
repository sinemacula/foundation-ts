/**
 * Network-connectivity port the kernel uses to pause polling while offline.
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

    /**
     * Begin observing connectivity changes. A no-op when already started.
     */
    start(): void;

    /**
     * Stop observing and detach listeners. A no-op when not started.
     */
    stop(): void;

    /**
     * Subscribe to connectivity changes.
     *
     * @returns an unsubscribe function
     */
    onChange(handler: ConnectivityHandler): () => void;
}
