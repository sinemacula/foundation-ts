/**
 * Permission-set evaluation primitive.
 *
 * The kernel's only authorization primitive: a flat list of granted permission
 * strings with wildcard-prefix support. Role models, permission hierarchies,
 * and where the granted list comes from (a user record, a membership, an API
 * token) are all app concerns layered on top of this.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A read-only set of granted permission strings.
 *
 * Wildcard grammar: a granted entry ending in `.*`, `:*`, or the bare `*` acts
 * as a prefix grant.
 *
 * - `'*'` allows every permission.
 * - `'users.*'` allows `'users.view'` and `'users.edit.self'`, but not
 *   `'usersx.view'` - the wildcard only matches at the declared prefix boundary
 *   (the character preceding `*` is part of the match).
 * - `'users:*'` allows `'users:view'` following the same rule with a `:`
 *   boundary instead of a `.` boundary.
 *
 * An empty granted set allows nothing.
 */
export class PermissionSet {
    /** The granted permission strings backing this set. */
    readonly #granted: readonly string[];

    constructor(granted: readonly string[]) {
        this.#granted = granted;
    }

    /**
     * Determine whether the set grants a permission.
     *
     * @param permission - the permission string to check, matched exactly and
     * case-sensitively unless a granted entry is a wildcard prefix grant
     * @returns true when an exact match or a matching wildcard grant exists
     */
    allows(permission: string): boolean {
        return this.#granted.some(entry => matchesGrant(entry, permission));
    }
}

/**
 * Determine whether a single granted entry covers a requested permission.
 *
 * @param entry - a single granted permission string
 * @param permission - the requested permission string
 * @returns true when `entry` exactly matches or wildcard-covers `permission`
 */
function matchesGrant(entry: string, permission: string): boolean {
    if (entry === '*' || entry === permission) {
        return true;
    }

    const prefix = wildcardPrefix(entry);

    return prefix !== null && permission.startsWith(prefix);
}

/**
 * Extract the boundary-inclusive prefix from a wildcard grant.
 *
 * @param entry - a single granted permission string
 * @returns the prefix (including its trailing `.` or `:`) when `entry` is a
 * wildcard grant, otherwise `null`
 */
function wildcardPrefix(entry: string): string | null {
    return entry.endsWith('.*') || entry.endsWith(':*') ? entry.slice(0, -1) : null;
}
