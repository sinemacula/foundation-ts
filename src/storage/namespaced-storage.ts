/**
 * Namespace-prefixing decorator for key-value storage.
 *
 * Several applications (or extracted packages) can share one browser origin's
 * storage; without a namespace, one application's keys can collide with, or be
 * overwritten by, another's. This decorates any `KeyValueStorage` - including
 * another `NamespacedStorage` - rewriting every key with a namespace prefix
 * before delegating.
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
     * Wrap an inner storage, prefixing every key with `namespace`.
     *
     * @param inner - the storage to delegate to, keyed under the composed
     * prefix
     * @param namespace - the prefix composed onto every key, joined with a dot
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
     * Compose `key` with this storage's namespace.
     *
     * @param key - the caller-supplied key
     * @returns the key prefixed with the namespace, joined with a dot
     */
    #namespacedKey(key: string): string {
        return `${this.#namespace}.${key}`;
    }
}
