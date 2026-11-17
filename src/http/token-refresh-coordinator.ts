/**
 * Single-flight coordination for token refreshes.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Performs the actual token refresh. A refresh sent through an HTTP client
 * whose unauthorized handler joins this refresh must opt out of that handler,
 * or its 401 waits on itself.
 *
 * @typeParam T - what a refresh resolves with; true when the session was
 * refreshed, by default
 */
export interface TokenRefresher<T = boolean> {
    /**
     * Attempt to refresh the session.
     */
    refresh(): Promise<T>;
}

/**
 * Deduplicates concurrent refresh attempts into a single in-flight call, so
 * requests failing with 401 together share one refresh. The deduplication is
 * per instance: separate JavaScript contexts sharing a session, such as browser
 * tabs, can still refresh concurrently.
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
     */
    refresh(): Promise<T> {
        this.#inFlight ??= this.#refresher.refresh().finally(() => {
            this.#inFlight = null;
        });

        return this.#inFlight;
    }
}
