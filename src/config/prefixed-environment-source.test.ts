/**
 * Unit tests for prefixed-environment-source.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { PrefixedEnvironmentSource } from './prefixed-environment-source';

/**
 * Build a record from pairs, keeping env-style keys out of object literals.
 */
function wire<T>(entries: ReadonlyArray<readonly [string, T]>): Record<string, T> {
    return Object.fromEntries(entries);
}

describe('PrefixedEnvironmentSource', () => {
    it('returns the string value stored under the prefixed key', () => {
        const source = new PrefixedEnvironmentSource(wire([['VITE_API_URL', 'https://api.example.com']]), 'VITE_');

        expect(source.get('API_URL')).toBe('https://api.example.com');
    });

    it('returns undefined when the prefixed key is absent', () => {
        const source = new PrefixedEnvironmentSource(wire([['VITE_FOO', 'bar']]), 'VITE_');

        expect(source.get('MISSING')).toBeUndefined();
    });

    it('returns undefined for an empty record', () => {
        const source = new PrefixedEnvironmentSource({}, 'VITE_');

        expect(source.get('ANY')).toBeUndefined();
    });

    it.each([
        ['a number', 42],
        ['a boolean', true],
        ['null', null],
    ])('returns undefined when the prefixed value is %s', (_, value) => {
        const source = new PrefixedEnvironmentSource(wire([['VITE_KEY', value]]), 'VITE_');

        expect(source.get('KEY')).toBeUndefined();
    });

    it('uses the exact prefix provided', () => {
        const source = new PrefixedEnvironmentSource(wire([['APP_URL', 'https://app.example.com']]), 'APP_');

        expect(source.get('URL')).toBe('https://app.example.com');
    });
});
