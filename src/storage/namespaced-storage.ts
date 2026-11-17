/**
 * Storage decorator that namespaces keys so apps sharing an origin don't clash.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { KeyValueStorage } from './key-value-storage';

/**
 * Prefix every key with a namespace before delegating to an inner storage.
 */
export class NamespacedStorage implements KeyValueStorage {
    /** The storage the namespaced keys delegate to. */
    readonly #inner: KeyValueStorage;

    /** The prefix composed onto every key. */
    readonly #namespace: string;

    /**
     * Wrap `inner`, prefixing every key with `namespace` and a dot.
     */
    constructor(inner: KeyValueStorage, namespace: string) {
        this.#inner = inner;
        this.#namespace = namespace;
    }

    /**
     * Read the namespaced key from the inner storage.
     */
    get(key: string): string | null {
        return this.#inner.get(this.#namespacedKey(key));
    }

    /**
     * Write the value under the namespaced key in the inner storage.
     */
    set(key: string, value: string): void {
        this.#inner.set(this.#namespacedKey(key), value);
    }

    /**
     * Remove the namespaced key from the inner storage.
     */
    remove(key: string): void {
        this.#inner.remove(this.#namespacedKey(key));
    }

    /**
     * Prefix `key` with this storage's namespace and a dot.
     */
    #namespacedKey(key: string): string {
        return `${this.#namespace}.${key}`;
    }
}
