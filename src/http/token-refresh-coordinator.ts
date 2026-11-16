/**
 * Single-flight coordination for token refreshes.
 *
 * When several requests fail with 401 at once, only one refresh may run; every
 * caller awaits the same in-flight attempt. The coordination is per instance,
 * so it deduplicates within one JavaScript context only; separate contexts
 * sharing a session (browser tabs) can still refresh concurrently.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Performs the actual token refresh.
 *
 * @typeParam T - what a refresh resolves with; true when the session was
 * refreshed, by default
 */
export interface TokenRefresher<T = boolean> {
    /**
     * Attempt to refresh the session.
     *
     * @returns the refresh result
     */
    refresh(): Promise<T>;
}

/**
 * Deduplicates concurrent refresh attempts into a single in-flight call.
 *
 * @typeParam T - what a refresh resolves with
 */
export class TokenRefreshCoordinator<T = boolean> {
    /** The delegate that performs the actual refresh. */
    readonly #refresher: TokenRefresher<T>;

    /** The in-flight refresh shared by concurrent callers, or null. */
    #inFlight: Promise<T> | null = null;

    constructor(refresher: TokenRefresher<T>) {
        this.#refresher = refresher;
    }

    /**
     * Refresh the session, joining any refresh already in flight.
     *
     * @returns the shared refresh result
     */
    refresh(): Promise<T> {
        this.#inFlight ??= this.#refresher.refresh().finally(() => {
            this.#inFlight = null;
        });

        return this.#inFlight;
    }
}
