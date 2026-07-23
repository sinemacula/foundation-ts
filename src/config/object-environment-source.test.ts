/**
 * Unit tests for object-environment-source.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { ObjectEnvironmentSource } from './object-environment-source';

/**
 * Build a `Record<string, string>` from an array of `[key, value]` pairs.
 *
 * Wraps `Object.fromEntries` so callers can write wire-field names as plain
 * string literals inside array elements rather than as object-literal keys -
 * keeping non-camelCase environment keys out of any position that Biome's
 * naming-convention or literal-keys rules inspect.
 *
 * @param entries - key-value pairs for the record
 * @returns a plain `Record<string, string>`
 */
function wire(entries: ReadonlyArray<readonly [string, string]>): Record<string, string> {
    return Object.fromEntries(entries);
}

describe('ObjectEnvironmentSource', () => {
    it('returns the value for a defined key', () => {
        const source = new ObjectEnvironmentSource(wire([['API_URL', 'https://api.example.com']]));

        expect(source.get('API_URL')).toBe('https://api.example.com');
    });

    it('returns undefined for a key not present in the record', () => {
        const source = new ObjectEnvironmentSource(wire([['FOO', 'bar']]));

        expect(source.get('MISSING')).toBeUndefined();
    });

    it('returns undefined for an empty record', () => {
        const source = new ObjectEnvironmentSource({});

        expect(source.get('ANY')).toBeUndefined();
    });

    it('returns the correct value when multiple keys are present', () => {
        const source = new ObjectEnvironmentSource(
            wire([
                ['A', '1'],
                ['B', '2'],
                ['C', '3'],
            ]),
        );

        expect(source.get('B')).toBe('2');
    });
});
