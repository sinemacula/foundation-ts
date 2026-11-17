/**
 * Unit tests for chain-environment-source.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { ChainEnvironmentSource } from './chain-environment-source';
import type { EnvironmentSource } from './environment';

/**
 * Build a record from pairs, keeping env-style keys out of object literals.
 */
function wire(entries: ReadonlyArray<readonly [string, string]>): Record<string, string> {
    return Object.fromEntries(entries);
}

/**
 * Build an environment source backed by a fixed record.
 */
function sourceFrom(values: Record<string, string>): EnvironmentSource {
    return { get: (key: string) => values[key] };
}

/**
 * Build an environment source that defines no keys.
 */
function emptySource(): EnvironmentSource {
    return { get: () => undefined };
}

describe('ChainEnvironmentSource', () => {
    it('returns the value from the first source that defines the key', () => {
        const chain = new ChainEnvironmentSource([
            sourceFrom(wire([['API_URL', 'https://runtime.example.com']])),
            sourceFrom(wire([['API_URL', 'https://build.example.com']])),
        ]);

        expect(chain.get('API_URL')).toBe('https://runtime.example.com');
    });

    it('falls through to the next source that defines the key', () => {
        const chain = new ChainEnvironmentSource([
            emptySource(),
            sourceFrom(wire([['API_URL', 'https://build.example.com']])),
        ]);

        expect(chain.get('API_URL')).toBe('https://build.example.com');
    });

    it('returns undefined when no source defines the key', () => {
        const chain = new ChainEnvironmentSource([emptySource(), emptySource()]);

        expect(chain.get('MISSING')).toBeUndefined();
    });

    it('returns undefined for an empty chain', () => {
        const chain = new ChainEnvironmentSource([]);

        expect(chain.get('ANY')).toBeUndefined();
    });

    it('returns the value from a single-source chain', () => {
        const chain = new ChainEnvironmentSource([sourceFrom(wire([['KEY', 'value']]))]);

        expect(chain.get('KEY')).toBe('value');
    });

    it('falls through several empty sources to a match', () => {
        const chain = new ChainEnvironmentSource([emptySource(), emptySource(), sourceFrom(wire([['DEEP', 'found']]))]);

        expect(chain.get('DEEP')).toBe('found');
    });
});
