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
    /** The connectivity last observed; it does not follow the platform while stopped. */
    readonly online: boolean;

    /**
     * Begin observing connectivity changes, resampling the platform and
     * notifying once when it differs from `online`. A no-op when already
     * started.
     */
    start(): void;

    /**
     * Stop observing and detach listeners, so nothing is observed until the
     * next start. A no-op when not started.
     */
    stop(): void;

    /**
     * Subscribe to connectivity changes.
     *
     * @returns an unsubscribe function
     */
    onChange(handler: ConnectivityHandler): () => void;
}
