/**
 * Unit tests for environment.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import type { EnvironmentSource } from './environment';
import { Environment } from './environment';

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

describe('Environment', () => {
    describe('string', () => {
        it('returns the raw value when the key is defined', () => {
            const env = new Environment(sourceFrom(wire([['FOO', 'bar']])));

            expect(env.string('FOO')).toBe('bar');
        });

        it('returns undefined when the key is missing and no fallback is provided', () => {
            const env = new Environment(emptySource());

            expect(env.string('MISSING')).toBeUndefined();
        });

        it('returns the fallback when the key is missing', () => {
            const env = new Environment(emptySource());

            expect(env.string('MISSING', 'default')).toBe('default');
        });

        it('returns the defined value even when a fallback is provided', () => {
            const env = new Environment(sourceFrom(wire([['FOO', 'actual']])));

            expect(env.string('FOO', 'fallback')).toBe('actual');
        });
    });

    describe('boolean', () => {
        it('returns true for the truthy string "1"', () => {
            const env = new Environment(sourceFrom(wire([['FLAG', '1']])));

            expect(env.boolean('FLAG')).toBe(true);
        });

        it('returns true for the truthy string "true"', () => {
            const env = new Environment(sourceFrom(wire([['FLAG', 'true']])));

            expect(env.boolean('FLAG')).toBe(true);
        });

        it('returns true for the truthy string "yes"', () => {
            const env = new Environment(sourceFrom(wire([['FLAG', 'yes']])));

            expect(env.boolean('FLAG')).toBe(true);
        });

        it('returns true for the truthy string "on"', () => {
            const env = new Environment(sourceFrom(wire([['FLAG', 'on']])));

            expect(env.boolean('FLAG')).toBe(true);
        });

        it('returns true for an uppercase truthy string "TRUE"', () => {
            const env = new Environment(sourceFrom(wire([['FLAG', 'TRUE']])));

            expect(env.boolean('FLAG')).toBe(true);
        });

        it('returns true for a mixed-case truthy string "Yes"', () => {
            const env = new Environment(sourceFrom(wire([['FLAG', 'Yes']])));

            expect(env.boolean('FLAG')).toBe(true);
        });

        it('returns false for the string "false"', () => {
            const env = new Environment(sourceFrom(wire([['FLAG', 'false']])));

            expect(env.boolean('FLAG')).toBe(false);
        });

        it('returns false for the string "0"', () => {
            const env = new Environment(sourceFrom(wire([['FLAG', '0']])));

            expect(env.boolean('FLAG')).toBe(false);
        });

        it('returns false for an arbitrary non-truthy string', () => {
            const env = new Environment(sourceFrom(wire([['FLAG', 'no']])));

            expect(env.boolean('FLAG')).toBe(false);
        });

        it('returns undefined when the key is missing and no fallback is provided', () => {
            const env = new Environment(emptySource());

            expect(env.boolean('MISSING')).toBeUndefined();
        });

        it('returns the fallback when the key is missing', () => {
            const env = new Environment(emptySource());

            expect(env.boolean('MISSING', true)).toBe(true);
        });

        it('returns the parsed value even when a fallback is provided', () => {
            const env = new Environment(sourceFrom(wire([['FLAG', '1']])));

            expect(env.boolean('FLAG', false)).toBe(true);
        });
    });

    describe('integer', () => {
        it('returns the parsed integer for a valid numeric string', () => {
            const env = new Environment(sourceFrom(wire([['PORT', '3000']])));

            expect(env.integer('PORT')).toBe(3000);
        });

        it('returns undefined when the key is missing and no fallback is provided', () => {
            const env = new Environment(emptySource());

            expect(env.integer('MISSING')).toBeUndefined();
        });

        it('returns the fallback when the key is missing', () => {
            const env = new Environment(emptySource());

            expect(env.integer('MISSING', 8080)).toBe(8080);
        });

        it('returns the fallback when the value does not parse as an integer', () => {
            const env = new Environment(sourceFrom(wire([['PORT', 'abc']])));

            expect(env.integer('PORT', 80)).toBe(80);
        });

        it('returns undefined when the value is invalid and no fallback is provided', () => {
            const env = new Environment(sourceFrom(wire([['PORT', 'abc']])));

            expect(env.integer('PORT')).toBeUndefined();
        });

        it('returns the parsed value even when a fallback is provided', () => {
            const env = new Environment(sourceFrom(wire([['PORT', '9000']])));

            expect(env.integer('PORT', 80)).toBe(9000);
        });
    });

    describe('json', () => {
        it('returns the parsed object for a valid JSON string', () => {
            const env = new Environment(sourceFrom(wire([['DATA', '{"x":1}']])));

            expect(env.json('DATA')).toStrictEqual({ x: 1 });
        });

        it('returns the parsed array for a valid JSON array string', () => {
            const env = new Environment(sourceFrom(wire([['DATA', '[1,2,3]']])));

            expect(env.json('DATA')).toStrictEqual([1, 2, 3]);
        });

        it('returns undefined when the key is missing and no fallback is provided', () => {
            const env = new Environment(emptySource());

            expect(env.json('MISSING')).toBeUndefined();
        });

        it('returns the fallback when the key is missing', () => {
            const env = new Environment(emptySource());

            expect(env.json('MISSING', { default: true })).toStrictEqual({ default: true });
        });

        it('returns the fallback when the value is not valid JSON', () => {
            const env = new Environment(sourceFrom(wire([['DATA', '{broken']])));

            expect(env.json('DATA', null)).toBeNull();
        });

        it('returns undefined when the value is invalid JSON and no fallback is provided', () => {
            const env = new Environment(sourceFrom(wire([['DATA', '{broken']])));

            expect(env.json('DATA')).toBeUndefined();
        });

        it('returns the parsed value even when a fallback is provided', () => {
            const env = new Environment(sourceFrom(wire([['DATA', '"hello"']])));

            expect(env.json<string>('DATA', 'fallback')).toBe('hello');
        });
    });
});
