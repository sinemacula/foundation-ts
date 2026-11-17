/**
 * Unit tests for post-login redirect target handling.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { REDIRECT_QUERY_KEY, sanitiseRedirectTarget } from './redirect';

const ORIGIN = 'https://app.example';

/**
 * Resolve a target the way a browser navigating to it would.
 */
function originOf(target: string): string {
    return new URL(target, ORIGIN).origin;
}

describe('sanitiseRedirectTarget', () => {
    it.each([
        ['a relative path', '/dashboard', '/login'],
        ['the root path', '/', '/login'],
        ['a nested path carrying its own query string', '/settings/billing?tab=invoices', '/login'],
        ['the default login path under a custom login path', '/login', '/signin'],
        ['an ordinary path under a custom login path', '/dashboard', '/signin'],
        ['a path with a space', '/a b', '/login'],
        ['a path that only starts with the login path', '/login-help', '/login'],
        ['a longer segment sharing the login prefix', '/loginx', '/login'],
        ['a hash naming the login path', '/dashboard#login', '/login'],
        ['a query carrying dot segments', '/search?q=/../login', '/login'],
        ['a segment containing dots', '/a..b', '/login'],
        ['a path beside a login path with a trailing slash', '/login-help', '/login/'],
    ])('accepts %s, which resolves to the same origin', (_label, target, loginPath) => {
        expect(sanitiseRedirectTarget(target, loginPath)).toBe(target);
        expect(originOf(target)).toBe(ORIGIN);
    });

    it.each([
        ['a protocol-relative target', '//evil.example.com', '/login'],
        ['an absolute external url', 'https://evil.example.com', '/login'],
        ['a target containing a backslash', '/\\evil.example.com', '/login'],
        ['a tab before a protocol-relative target', '/\t/evil.example.com', '/login'],
        ['a line feed before a protocol-relative target', '/\n/evil.example.com', '/login'],
        ['a carriage return before a protocol-relative target', '/\r/evil.example.com', '/login'],
        ['a CRLF before a protocol-relative target', '/\r\n/evil.example.com', '/login'],
        ['a NUL character', '/\u0000/evil.example.com', '/login'],
        ['a unit separator', '/\u001F/evil.example.com', '/login'],
        ['a DEL character', '/\u007F/evil.example.com', '/login'],
        ['a leading space', ' /dashboard', '/login'],
        ['a parent segment resolving to the login path', '/x/../login', '/login'],
        ['an encoded parent segment', '/%2E%2e/login', '/login'],
        ['a current-directory segment', '/./dashboard', '/login'],
        ['a trailing parent segment', '/dashboard/..', '/login'],
        ['the login path', '/login', '/login'],
        ['the login path in another case', '/Login', '/login'],
        ['the login path in another case carrying a query', '/LOGIN?x=1', '/login'],
        ['the login path with a trailing slash', '/login/', '/login'],
        ['the login path carrying a hash', '/login#x', '/login'],
        ['the login path carrying its own query', '/login?redirect=%2F', '/login'],
        ['a path under the login path', '/login/help', '/login'],
        ['the login path under a login path with a trailing slash', '/login', '/login/'],
        ['a non-string value', 42, '/login'],
        ['an array value', ['/dashboard'], '/login'],
        ['a custom login path', '/signin', '/signin'],
        ['a custom login path carrying its own query', '/signin?redirect=%2F', '/signin'],
        ['a protocol-relative target under a custom login path', '//evil.example.com', '/signin'],
    ])('rejects %s', (_label, target, loginPath) => {
        expect(sanitiseRedirectTarget(target, loginPath)).toBeNull();
    });

    it('handles a login path with a long run of slashes without backtracking over it', () => {
        const loginPath = `/login${'/'.repeat(100_000)}x`;

        expect(sanitiseRedirectTarget('/dashboard', loginPath)).toBe('/dashboard');
        expect(sanitiseRedirectTarget('/login/x', `/login${'/'.repeat(100_000)}`)).toBeNull();
    });

    it.each(['', '/', '//'])('rejects every target under the login path %j', loginPath => {
        expect(sanitiseRedirectTarget('/dashboard', loginPath)).toBeNull();
        expect(sanitiseRedirectTarget('/', loginPath)).toBeNull();
    });

    it.each([
        '/\t/evil.example.com',
        '/\n/evil.example.com',
        '/\r/evil.example.com',
        '/\r\n/evil.example.com',
        '/\u0000/evil.example.com',
        '//evil.example.com',
        '/\\evil.example.com',
        ' //evil.example.com',
        '/%2F/evil.example.com',
        '/%5C/evil.example.com',
    ])('never returns a hostile target %j that resolves to another origin', target => {
        const result = sanitiseRedirectTarget(target, '/login');

        expect(result === null || originOf(result) === ORIGIN).toBe(true);
    });
});

describe('REDIRECT_QUERY_KEY', () => {
    it('names the redirect query parameter', () => {
        expect(REDIRECT_QUERY_KEY).toBe('redirect');
    });
});
