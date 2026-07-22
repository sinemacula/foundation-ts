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

function sourceFrom(values: Record<string, string>): EnvironmentSource {
    return { get: (key: string) => values[key] };
}

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

    it('falls through to the second source when the first does not define the key', () => {
        const chain = new ChainEnvironmentSource([
            emptySource(),
            sourceFrom(wire([['API_URL', 'https://build.example.com']])),
        ]);

        expect(chain.get('API_URL')).toBe('https://build.example.com');
    });

    it('returns undefined when no source in the chain defines the key', () => {
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

    it('falls through multiple undefined sources before finding a match', () => {
        const chain = new ChainEnvironmentSource([emptySource(), emptySource(), sourceFrom(wire([['DEEP', 'found']]))]);

        expect(chain.get('DEEP')).toBe('found');
    });
});
