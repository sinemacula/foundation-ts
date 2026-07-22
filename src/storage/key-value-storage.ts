/**
 * Key-value storage port.
 *
 * Everything that persists small client-side values (tokens, locale choice)
 * depends on this contract rather than on `window.localStorage`, so services
 * stay testable and storage failures stay contained in one adapter.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A minimal string key-value store.
 */
export interface KeyValueStorage {
    /**
     * Resolve the value for `key`.
     *
     * @param key - the storage key
     * @returns the stored value, or null when absent
     */
    get(key: string): string | null;

    /**
     * Store `value` under `key`.
     *
     * @param key - the storage key
     * @param value - the value to store
     */
    set(key: string, value: string): void;

    /**
     * Remove the value stored under `key`.
     *
     * @param key - the storage key
     */
    remove(key: string): void;
}
