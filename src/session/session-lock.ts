/**
 * Session lock port.
 *
 * Serialises the read-compare-write steps of a persistence adapter so each
 * conditional write is atomic. A browser implements it with the Web Locks API,
 * under one lock name shared by every tab writing the same storage key.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Runs tasks one at a time across every context sharing the lock.
 */
export interface SessionLock {
    /**
     * Run the task once every task started before it has settled.
     *
     * @param task - the task to run while holding the lock
     * @returns the task's result
     */
    run<T>(task: () => Promise<T>): Promise<T>;
}
