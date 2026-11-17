/**
 * Key-value storage port for small client-side values such as tokens.
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
     * @returns the stored value, or null when absent
     */
    get(key: string): string | null;

    /**
     * Store `value` under `key`.
     */
    set(key: string, value: string): void;

    /**
     * Remove the value stored under `key`.
     */
    remove(key: string): void;
}
