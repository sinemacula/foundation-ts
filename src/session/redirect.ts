/**
 * Post-login redirect target handling.
 *
 * Guarded navigations attach the originally-requested path as a query parameter
 * so the login screen can return the visitor there once signed in. Only
 * same-origin, relative paths are ever honoured; anything else is treated as
 * untrusted input and discarded.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Query parameter under which the post-login redirect target is carried.
 */
export const REDIRECT_QUERY_KEY = 'redirect';

/**
 * Validate an untrusted value as a safe post-login redirect target.
 *
 * Only a same-origin, relative path is accepted: it must start with a single
 * `/` (protocol-relative `//` targets are rejected), must not contain a
 * backslash, and must not point back at the login screen (which would bounce
 * the visitor in a loop).
 *
 * @param target - the untrusted candidate, typically a route query value
 * @param loginPath - the login-path prefix rejected as a loop guard
 * @returns the sanitised path, or `null` when the value is not a safe target
 */
export function sanitiseRedirectTarget(target: unknown, loginPath: string): string | null {
    if (typeof target !== 'string') {
        return null;
    }

    if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\') || target.startsWith(loginPath)) {
        return null;
    }

    return target;
}
