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
