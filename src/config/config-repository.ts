/**
 * Immutable, deep-frozen configuration tree with dot-notation lookup.
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
     * Return the full, typed and frozen configuration tree.
     */
    all(): Readonly<T> {
        return this.#values;
    }

    /**
     * Resolve a value by dot-notation path, reading own properties only, so
     * inherited members such as `toString` never resolve.
     *
     * @param path - the dot-notation path (e.g. `app.urls.api`)
     * @param fallback - the value returned when the path does not resolve
     */
    get(path: string, fallback: unknown = undefined): unknown {
        let current: unknown = this.#values;

        for (const segment of path.split('.')) {
            if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
                return fallback;
            }

            current = (current as Record<string, unknown>)[segment];
        }

        return current;
    }

    /**
     * Determine whether a dot-notation path resolves to a value.
     */
    has(path: string): boolean {
        return this.get(path, MISSING) !== MISSING;
    }
}
