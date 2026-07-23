/**
 * Immutable repository over a resolved configuration tree.
 *
 * The tree is deep-frozen on construction; nothing can mutate configuration
 * after boot. Values are reachable both through the typed root (`all()`) and
 * through Laravel-style dot notation (`get('app.urls.api')`).
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { deepFreeze } from '../support/deep-freeze';

const MISSING = Symbol('missing');

/**
 * Read-only, dot-notation-addressable configuration store.
 */
export class ConfigRepository<T extends Record<string, unknown>> {
    /** The deep-frozen configuration tree. */
    readonly #values: Readonly<T>;

    constructor(values: T) {
        this.#values = deepFreeze(values);
    }

    /**
     * The full, typed configuration tree.
     *
     * @returns the frozen configuration root
     */
    all(): Readonly<T> {
        return this.#values;
    }

    /**
     * Resolve a value by dot-notation path.
     *
     * @param path - the dot-notation path (e.g. `app.urls.api`)
     * @param fallback - the value returned when the path does not resolve
     * @returns the resolved value, or the fallback
     */
    get(path: string, fallback: unknown = undefined): unknown {
        let current: unknown = this.#values;

        for (const segment of path.split('.')) {
            if (current === null || typeof current !== 'object' || !(segment in current)) {
                return fallback;
            }

            current = (current as Record<string, unknown>)[segment];
        }

        return current;
    }

    /**
     * Determine whether a dot-notation path resolves to a value.
     *
     * @param path - the dot-notation path
     * @returns true when the path resolves
     */
    has(path: string): boolean {
        return this.get(path, MISSING) !== MISSING;
    }
}
