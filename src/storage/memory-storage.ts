/**
 * In-memory key-value storage adapter.
 *
 * Used in tests and as a runtime fallback when no browser storage is available.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { KeyValueStorage } from './key-value-storage';

/**
 * Persist values in a process-local map.
 */
export class MemoryStorage implements KeyValueStorage {
    /** The backing in-memory map. */
    readonly #values = new Map<string, string>();

    /**
     * Read from the in-memory map, returning null when the key is absent.
     */
    get(key: string): string | null {
        return this.#values.get(key) ?? null;
    }

    /**
     * Store the value in the in-memory map.
     */
    set(key: string, value: string): void {
        this.#values.set(key, value);
    }

    /**
     * Drop the key from the in-memory map.
     */
    remove(key: string): void {
        this.#values.delete(key);
    }
}
