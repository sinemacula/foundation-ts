/**
 * Recursive freezing utility for immutable value trees.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * The read-only view of a deep-frozen value: nested properties are readonly and
 * arrays become readonly arrays, while functions keep their signature.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/**
 * Freeze `value` in place along with every object reached through enumerable
 * own string-keyed properties, descending below nodes that are already frozen.
 * Functions are neither frozen nor traversed, and cycles are safe. Intended for
 * plain data objects and arrays, with no guarantee for accessors, class
 * internals or Map and Set contents.
 *
 * @returns the same reference, deeply frozen
 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
    freezeReachable(value, new WeakSet());

    return value as DeepReadonly<T>;
}

/**
 * Freeze an object, then each object among its property values, visiting every
 * node once.
 *
 * @param visited - the nodes this traversal has already frozen
 */
function freezeReachable(value: unknown, visited: WeakSet<object>): void {
    if (value === null || typeof value !== 'object' || visited.has(value)) {
        return;
    }

    visited.add(value);
    Object.freeze(value);

    for (const property of Object.values(value)) {
        freezeReachable(property, visited);
    }
}
