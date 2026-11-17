/**
 * Flat permission-set evaluation; roles and hierarchies are app concerns.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A read-only set of granted permission names, evaluated as the server does.
 *
 * Each granted name is a glob in which every `*` matches any run of characters,
 * `:` included; every other character is literal. Matching is anchored and
 * case-sensitive, so `posts:*` allows `posts:create` and `posts:edit:own` but
 * not `postsx:create`, `*:view` allows `posts:view`, and `*` allows everything.
 * The permission being checked is never a pattern.
 *
 * An empty granted set allows nothing.
 */
export class PermissionSet {
    /** The granted permission names backing this set. */
    readonly #granted: readonly string[];

    constructor(granted: readonly string[]) {
        this.#granted = granted;
    }

    /**
     * Determine whether the set grants a permission.
     */
    allows(permission: string): boolean {
        return this.#granted.some(grant => matchesGrant(grant, permission));
    }
}

/**
 * Determine whether a granted name matches a permission, treating every `*` in
 * the grant as a wildcard.
 */
function matchesGrant(grant: string, permission: string): boolean {
    const firstStar = grant.indexOf('*');

    if (firstStar === -1) {
        return grant === permission;
    }

    const lastStar = grant.lastIndexOf('*');
    const head = grant.slice(0, firstStar);
    const tail = grant.slice(lastStar + 1);

    if (!permission.startsWith(head) || !permission.endsWith(tail)) {
        return false;
    }

    const tailStart = permission.length - tail.length;
    let cursor = head.length;

    // Leftmost placement is exact for star-only globs.
    for (const middle of grant.slice(firstStar + 1, lastStar).split('*')) {
        const index = permission.indexOf(middle, cursor);

        if (index === -1 || index + middle.length > tailStart) {
            return false;
        }

        cursor = index + middle.length;
    }

    return true;
}
