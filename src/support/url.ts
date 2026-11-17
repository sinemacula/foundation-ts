/**
 * URL helpers.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Strip the query string and fragment from a URL, which can carry secrets such
 * as reset tokens or authorization codes, before it is logged or reported.
 *
 * @returns the URL up to its first `?` or `#`
 */
export function stripQueryAndFragment(url: string): string {
    const end = url.search(/[?#]/u);

    return end === -1 ? url : url.slice(0, end);
}

/**
 * Form-encode query pairs in order, replacing lone surrogates with U+FFFD as
 * Node's encoder does, since a strict encoder throws on them instead.
 *
 * @returns the query string, without a leading `?`
 */
export function encodeQuery(pairs: Iterable<readonly [string, string]>): string {
    const search = new URLSearchParams();

    for (const [key, value] of pairs) {
        // Minimal URLSearchParams implementations may ship append only.
        search.append(toWellFormed(key), toWellFormed(value));
    }

    return search.toString();
}

/**
 * Replace each lone surrogate with U+FFFD, keeping valid pairs.
 */
function toWellFormed(value: string): string {
    return value.replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
}
