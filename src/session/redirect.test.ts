/**
 * Unit tests for post-login redirect target handling.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { REDIRECT_QUERY_KEY, sanitiseRedirectTarget } from './redirect';

describe('sanitiseRedirectTarget', () => {
    it('accepts a valid relative path', () => {
        expect(sanitiseRedirectTarget('/dashboard', '/login')).toBe('/dashboard');
    });

    it('accepts the root path', () => {
        expect(sanitiseRedirectTarget('/', '/login')).toBe('/');
    });

    it('accepts a nested path carrying its own query string', () => {
        expect(sanitiseRedirectTarget('/settings/billing?tab=invoices', '/login')).toBe(
            '/settings/billing?tab=invoices',
        );
    });

    it('rejects a protocol-relative target', () => {
        expect(sanitiseRedirectTarget('//evil.example.com', '/login')).toBeNull();
    });

    it('rejects an absolute external url', () => {
        expect(sanitiseRedirectTarget('https://evil.example.com', '/login')).toBeNull();
    });

    it('rejects a target containing a backslash', () => {
        expect(sanitiseRedirectTarget('/\\evil.example.com', '/login')).toBeNull();
    });

    it('rejects the login path to avoid a bounce loop', () => {
        expect(sanitiseRedirectTarget('/login', '/login')).toBeNull();
    });

    it('rejects the login path carrying its own query', () => {
        expect(sanitiseRedirectTarget('/login?redirect=%2F', '/login')).toBeNull();
    });

    it('rejects any target sharing the login-path prefix', () => {
        expect(sanitiseRedirectTarget('/login/help', '/login')).toBeNull();
    });

    it('rejects a non-string value', () => {
        expect(sanitiseRedirectTarget(42, '/login')).toBeNull();
    });

    it('rejects an array value', () => {
        expect(sanitiseRedirectTarget(['/dashboard'], '/login')).toBeNull();
    });

    it('rejects a custom login path', () => {
        expect(sanitiseRedirectTarget('/signin', '/signin')).toBeNull();
    });

    it('rejects a custom login path carrying its own query', () => {
        expect(sanitiseRedirectTarget('/signin?redirect=%2F', '/signin')).toBeNull();
    });

    it('accepts another login-like path under a custom login path', () => {
        expect(sanitiseRedirectTarget('/login', '/signin')).toBe('/login');
    });

    it('still rejects a protocol-relative target under a custom login path', () => {
        expect(sanitiseRedirectTarget('//evil.example.com', '/signin')).toBeNull();
    });

    it('still accepts an ordinary path under a custom login path', () => {
        expect(sanitiseRedirectTarget('/dashboard', '/signin')).toBe('/dashboard');
    });
});

describe('REDIRECT_QUERY_KEY', () => {
    it('names the redirect query parameter', () => {
        expect(REDIRECT_QUERY_KEY).toBe('redirect');
    });
});
