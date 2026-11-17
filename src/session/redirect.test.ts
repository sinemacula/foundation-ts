/**
 * Unit tests for post-login redirect target handling.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { REDIRECT_QUERY_KEY, sanitiseRedirectTarget } from './redirect';

describe('sanitiseRedirectTarget', () => {
    it.each([
        ['a relative path', '/dashboard', '/login'],
        ['the root path', '/', '/login'],
        ['a nested path carrying its own query string', '/settings/billing?tab=invoices', '/login'],
        ['the default login path under a custom login path', '/login', '/signin'],
        ['an ordinary path under a custom login path', '/dashboard', '/signin'],
    ])('accepts %s', (_label, target, loginPath) => {
        expect(sanitiseRedirectTarget(target, loginPath)).toBe(target);
    });

    it.each([
        ['a protocol-relative target', '//evil.example.com', '/login'],
        ['an absolute external url', 'https://evil.example.com', '/login'],
        ['a target containing a backslash', '/\\evil.example.com', '/login'],
        ['the login path', '/login', '/login'],
        ['the login path carrying its own query', '/login?redirect=%2F', '/login'],
        ['any target sharing the login-path prefix', '/login/help', '/login'],
        ['a non-string value', 42, '/login'],
        ['an array value', ['/dashboard'], '/login'],
        ['a custom login path', '/signin', '/signin'],
        ['a custom login path carrying its own query', '/signin?redirect=%2F', '/signin'],
        ['a protocol-relative target under a custom login path', '//evil.example.com', '/signin'],
    ])('rejects %s', (_label, target, loginPath) => {
        expect(sanitiseRedirectTarget(target, loginPath)).toBeNull();
    });
});

describe('REDIRECT_QUERY_KEY', () => {
    it('names the redirect query parameter', () => {
        expect(REDIRECT_QUERY_KEY).toBe('redirect');
    });
});
