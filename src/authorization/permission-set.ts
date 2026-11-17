/**
 * Flat permission-set evaluation; roles and hierarchies are app concerns.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A read-only set of granted permission strings.
 *
 * Matching is exact and case-sensitive, except for wildcard grants:
 *
 * - `'*'` allows every permission.
 * - `'users.*'` allows `'users.view'` and `'users.edit.self'`, but not
 *   `'usersx.view'`; the `.` before `*` is part of the match.
 * - `'users:*'` allows `'users:view'` by the same rule with a `:` boundary.
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
     */
    allows(permission: string): boolean {
        return this.#granted.some(entry => matchesGrant(entry, permission));
    }
}

/**
 * Determine whether a granted entry exactly matches or wildcard-covers a
 * permission.
 */
function matchesGrant(entry: string, permission: string): boolean {
    if (entry === '*' || entry === permission) {
        return true;
    }

    const prefix = wildcardPrefix(entry);

    return prefix !== null && permission.startsWith(prefix);
}

/**
 * Extract the prefix, including its trailing `.` or `:`, from a wildcard grant.
 *
 * @returns the prefix, or null when `entry` is not a `.*` or `:*` grant
 */
function wildcardPrefix(entry: string): string | null {
    return entry.endsWith('.*') || entry.endsWith(':*') ? entry.slice(0, -1) : null;
}
