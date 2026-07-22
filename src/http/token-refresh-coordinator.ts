/**
 * Single-flight coordination for token refreshes.
 *
 * When several requests fail with 401 at once, only one refresh may run; every
 * caller awaits the same in-flight attempt - cross-request (and, combined with
 * shared storage, cross-tab) refresh safety as a reusable unit.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Performs the actual token refresh.
 */
export interface TokenRefresher {
    /**
     * Attempt to refresh the session.
     *
     * @returns true when the session was refreshed and requests may retry
     */
    refresh(): Promise<boolean>;
}

/**
 * Deduplicates concurrent refresh attempts into a single in-flight call.
 */
export class TokenRefreshCoordinator {
    /** The delegate that performs the actual refresh. */
    readonly #refresher: TokenRefresher;

    /** The in-flight refresh shared by concurrent callers, or null. */
    #inFlight: Promise<boolean> | null = null;

    constructor(refresher: TokenRefresher) {
        this.#refresher = refresher;
    }

    /**
     * Refresh the session, joining any refresh already in flight.
     *
     * @returns true when the session was refreshed
     */
    refresh(): Promise<boolean> {
        this.#inFlight ??= this.#refresher.refresh().finally(() => {
            this.#inFlight = null;
        });

        return this.#inFlight;
    }
}
