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

describe('Environment', () => {
    describe('string', () => {
        it('returns the raw value when the key is defined', () => {
            const env = new Environment(sourceFrom(wire([['FOO', 'bar']])));

            expect(env.string('FOO')).toBe('bar');
        });

        it('returns undefined for a missing key without a fallback', () => {
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
        it.each(['1', 'true', 'yes', 'on', 'TRUE', 'Yes'])('treats "%s" as true', value => {
            const env = new Environment(sourceFrom(wire([['FLAG', value]])));

            expect(env.boolean('FLAG')).toBe(true);
        });

        it.each(['false', '0', 'no'])('treats "%s" as false', value => {
            const env = new Environment(sourceFrom(wire([['FLAG', value]])));

            expect(env.boolean('FLAG')).toBe(false);
        });

        it('returns undefined for a missing key without a fallback', () => {
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
        it('parses a numeric string', () => {
            const env = new Environment(sourceFrom(wire([['PORT', '3000']])));

            expect(env.integer('PORT')).toBe(3000);
        });

        it('returns undefined for a missing key without a fallback', () => {
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

        it('returns undefined for an invalid value without a fallback', () => {
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

        it('returns undefined for a missing key without a fallback', () => {
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

        it('returns undefined for invalid JSON without a fallback', () => {
            const env = new Environment(sourceFrom(wire([['DATA', '{broken']])));

            expect(env.json('DATA')).toBeUndefined();
        });

        it('returns the parsed value even when a fallback is provided', () => {
            const env = new Environment(sourceFrom(wire([['DATA', '"hello"']])));

            expect(env.json<string>('DATA', 'fallback')).toBe('hello');
        });
    });
});
