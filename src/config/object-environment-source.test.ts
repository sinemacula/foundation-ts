/**
 * Unit tests for object-environment-source.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { ChainEnvironmentSource } from './chain-environment-source';
import { Environment } from './environment';
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

    it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
        'returns undefined for the inherited %s',
        key => {
            const source = new ObjectEnvironmentSource(wire([['FOO', 'bar']]));

            expect(source.get(key)).toBeUndefined();
        },
    );

    it('returns an own constructor entry', () => {
        const source = new ObjectEnvironmentSource(wire([['constructor', 'yes']]));

        expect(source.get('constructor')).toBe('yes');
    });

    it('lets a typed reader fall back for an inherited key instead of throwing', () => {
        const env = new Environment(new ObjectEnvironmentSource({}));

        expect(env.boolean('constructor', true)).toBe(true);
    });

    it('lets a chain fall through an inherited key to a later source', () => {
        const chain = new ChainEnvironmentSource([
            new ObjectEnvironmentSource({}),
            new ObjectEnvironmentSource(wire([['constructor', 'build']])),
        ]);

        expect(chain.get('constructor')).toBe('build');
    });
});
