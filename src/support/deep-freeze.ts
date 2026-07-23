/**
 * Recursive freezing utility for immutable value trees.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Recursively freeze `value` and every object reachable from it.
 *
 * Already-frozen branches are skipped, which also guards against cycles that
 * pass through a frozen node.
 *
 * @param value - the value tree to freeze in place
 * @returns the same value, deeply frozen
 */
export function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }

    for (const property of Object.values(value)) {
        deepFreeze(property);
    }

    return Object.freeze(value);
}
