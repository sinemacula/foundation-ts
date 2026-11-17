/**
 * Unit tests for object-environment-source.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { ObjectEnvironmentSource } from './object-environment-source';

/**
 * Build a record from pairs, keeping env-style keys out of object literals.
 */
function wire(entries: ReadonlyArray<readonly [string, string]>): Record<string, string> {
    return Object.fromEntries(entries);
}

describe('ObjectEnvironmentSource', () => {
    it('returns the value for a defined key', () => {
        const source = new ObjectEnvironmentSource(wire([['API_URL', 'https://api.example.com']]));

        expect(source.get('API_URL')).toBe('https://api.example.com');
    });

    it('returns undefined for a key the record omits', () => {
        const source = new ObjectEnvironmentSource(wire([['FOO', 'bar']]));

        expect(source.get('MISSING')).toBeUndefined();
    });

    it('returns undefined for an empty record', () => {
        const source = new ObjectEnvironmentSource({});

        expect(source.get('ANY')).toBeUndefined();
    });

    it('returns the matching value among several keys', () => {
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
