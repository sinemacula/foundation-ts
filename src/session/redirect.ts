/**
 * Post-login redirect target handling; only same-origin relative paths pass.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Query parameter under which the post-login redirect target is carried.
 */
export const REDIRECT_QUERY_KEY = 'redirect';

const QUERY_OR_HASH = /[?#].*/su;
const ENCODED_DOT = /%2e/giu;
const TRAILING_SLASHES = /\/+$/u;

/**
 * Validate an untrusted value as a safe post-login redirect target.
 *
 * Only a same-origin, relative path is accepted: it must start with a single
 * `/` (protocol-relative `//` targets are rejected), and must not contain a
 * backslash or a control character, which a URL parser would strip. Its path
 * must have no `.` or `..` segment, encoded or not, and must not be the login
 * path or lie under it, compared case-insensitively, which would bounce the
 * visitor in a loop. The query and hash are not inspected.
 *
 * @param target - the untrusted candidate, typically a route query value
 * @param loginPath - the login path rejected as a loop guard; empty or `/`
 * rejects every target
 * @returns the sanitised path, or `null` when the value is not a safe target
 */
export function sanitiseRedirectTarget(target: unknown, loginPath: string): string | null {
    if (typeof target !== 'string' || !isRelativePath(target)) {
        return null;
    }

    const path = target.replace(QUERY_OR_HASH, '');

    return hasDotSegment(path) || isUnderLoginPath(path, loginPath) ? null : target;
}

/**
 * Check for a path a URL parser resolves against the current origin.
 */
function isRelativePath(target: string): boolean {
    return target.startsWith('/') && !target.startsWith('//') && !target.includes('\\') && !hasControlCharacter(target);
}

/**
 * Check for a C0 control character or DEL.
 */
function hasControlCharacter(value: string): boolean {
    return [...value].some(character => character < ' ' || character === '\u007F');
}

/**
 * Check for a `.` or `..` segment, which a browser resolves away.
 */
function hasDotSegment(path: string): boolean {
    return path.split('/').some(segment => {
        const decoded = segment.replace(ENCODED_DOT, '.');

        return decoded === '.' || decoded === '..';
    });
}

/**
 * Check whether the path is the login path or lies under it.
 */
function isUnderLoginPath(path: string, loginPath: string): boolean {
    const login = loginPath.replace(TRAILING_SLASHES, '').toLowerCase();
    const candidate = path.toLowerCase();

    return candidate === login || candidate.startsWith(`${login}/`);
}
