/**
 * Lock port making each conditional persistence write atomic; a browser uses
 * the Web Locks API under one name per storage key.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Runs tasks one at a time across every context sharing the lock. Not
 * re-entrant: a task that waits on another run of the same lock never settles.
 */
export interface SessionLock {
    /**
     * Run the task once every task started before it has settled, handing back
     * its value, or its failure whether it rejects or throws.
     *
     * @param task - the task to run while holding the lock
     */
    run<T>(task: () => Promise<T>): Promise<T>;
}
