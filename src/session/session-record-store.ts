/**
 * Atomic record port the session snapshot persists through: one string record
 * every context shares, such as one IndexedDB key read and replaced in a single
 * readwrite transaction.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * One string record shared by every context, read and replaced atomically.
 *
 * Reads and swaps are linearisable across every context: an operation called
 * after another has resolved, in any context, observes its effect or a later
 * one, while overlapping operations take effect in either order.
 */
export interface SessionRecordStore {
    /**
     * Read the record.
     *
     * @returns the record, or null when none is stored
     */
    read(): Promise<string | null>;

    /**
     * In one atomic step, read the record, pass it to `decide` and store the
     * string it returns; null leaves the record as it is. A successful swap
     * runs `decide` exactly once, synchronously, and never after settling;
     * `decide` never throws and does no I/O or asynchronous work. Resolves once
     * the result is visible to every context, and rejects, storing nothing,
     * when the step fails.
     */
    swap(decide: (current: string | null) => string | null): Promise<void>;
}
