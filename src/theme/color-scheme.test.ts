/**
 * Unit tests for color-scheme.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { COLOR_SCHEME_STORAGE_KEY, composeColorSchemeStorageKey } from './color-scheme';

describe('color-scheme', () => {
    describe('COLOR_SCHEME_STORAGE_KEY', () => {
        it('is theme', () => {
            expect(COLOR_SCHEME_STORAGE_KEY).toBe('theme');
        });
    });

    describe('composeColorSchemeStorageKey', () => {
        it('prefixes the key with the namespace when given one', () => {
            expect(composeColorSchemeStorageKey('app')).toBe('app.theme');
        });

        it('prefixes a custom key with the namespace', () => {
            expect(composeColorSchemeStorageKey('app', 'scheme')).toBe('app.scheme');
        });

        it('returns the bare key when the namespace is null', () => {
            expect(composeColorSchemeStorageKey(null)).toBe('theme');
        });

        it('returns a custom bare key when the namespace is null', () => {
            expect(composeColorSchemeStorageKey(null, 'scheme')).toBe('scheme');
        });
    });
});
