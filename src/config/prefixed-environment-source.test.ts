/**
 * Unit tests for prefixed-environment-source.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { PrefixedEnvironmentSource } from './prefixed-environment-source';

/**
 * Build a `Record<string, T>` from an array of `[key, value]` pairs.
 *
 * Wraps `Object.fromEntries` so callers can write wire-field names as plain
 * string literals inside array elements rather than as object-literal keys -
 * keeping non-camelCase environment keys out of any position that Biome's
 * naming-convention or literal-keys rules inspect.
 *
 * @param entries - key-value pairs for the record
 * @returns a plain `Record<string, T>`
 */
function wire<T>(entries: ReadonlyArray<readonly [string, T]>): Record<string, T> {
    return Object.fromEntries(entries);
}

describe('PrefixedEnvironmentSource', () => {
    it('returns the string value for a key that exists under the prefix', () => {
        const source = new PrefixedEnvironmentSource(wire([['VITE_API_URL', 'https://api.example.com']]), 'VITE_');

        expect(source.get('API_URL')).toBe('https://api.example.com');
    });

    it('returns undefined for a key that does not exist under the prefix', () => {
        const source = new PrefixedEnvironmentSource(wire([['VITE_FOO', 'bar']]), 'VITE_');

        expect(source.get('MISSING')).toBeUndefined();
    });

    it('returns undefined for an empty record', () => {
        const source = new PrefixedEnvironmentSource({}, 'VITE_');

        expect(source.get('ANY')).toBeUndefined();
    });

    it('returns undefined when the prefixed key exists but has a non-string value', () => {
        const source = new PrefixedEnvironmentSource(wire([['VITE_COUNT', 42]]), 'VITE_');

        expect(source.get('COUNT')).toBeUndefined();
    });

    it('returns undefined when the prefixed key exists but has a boolean value', () => {
        const source = new PrefixedEnvironmentSource(wire([['VITE_FLAG', true]]), 'VITE_');

        expect(source.get('FLAG')).toBeUndefined();
    });

    it('returns undefined when the prefixed key exists but is null', () => {
        const source = new PrefixedEnvironmentSource(wire([['VITE_KEY', null]]), 'VITE_');

        expect(source.get('KEY')).toBeUndefined();
    });

    it('uses the exact prefix provided', () => {
        const source = new PrefixedEnvironmentSource(wire([['APP_URL', 'https://app.example.com']]), 'APP_');

        expect(source.get('URL')).toBe('https://app.example.com');
    });
});
