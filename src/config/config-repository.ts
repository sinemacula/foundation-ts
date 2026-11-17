/**
 * Immutable, deep-frozen configuration tree with dot-notation lookup.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { DeepReadonly } from '../support/deep-freeze';
import { deepFreeze } from '../support/deep-freeze';

export type { DeepReadonly } from '../support/deep-freeze';

const MISSING = Symbol('missing');

/**
 * Read-only, dot-notation-addressable configuration store.
 */
export class ConfigRepository<T extends object = Record<string, unknown>> {
    /** The deep-frozen configuration tree. */
    readonly #values: DeepReadonly<T>;

    /**
     * Freeze `values` in place, recursively through enumerable own string-keyed
     * properties and leaving functions untouched, then hold that reference.
     * Intended for plain data, with no guarantee for accessors, class internals
     * or Map and Set contents.
     */
    constructor(values: T) {
        this.#values = deepFreeze(values);
    }

    /**
     * Return the full, typed and frozen configuration tree.
     */
    all(): DeepReadonly<T> {
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
