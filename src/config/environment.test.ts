/**
 * Unit tests for environment.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

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

/**
 * Widen a value to its possibly-undefined type, as an optional fallback is.
 */
function optional<T>(value: T): T | undefined {
    return value;
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

        it.each([
            '30s',
            '10_000',
            '1e3',
            '1.5',
            '0x10',
            '1,000',
            'Infinity',
            '+5',
            ' 42 ',
            '9007199254740992',
            '-9007199254740992',
            '9007199254740993',
        ])('rejects "%s" as not a safe decimal integer', value => {
            const env = new Environment(sourceFrom(wire([['TIMEOUT', value]])));

            expect(env.integer('TIMEOUT', 5000)).toBe(5000);
            expect(env.integer('TIMEOUT')).toBeUndefined();
        });

        it.each([
            ['-5', -5],
            ['007', 7],
            ['9007199254740991', Number.MAX_SAFE_INTEGER],
            ['-9007199254740991', Number.MIN_SAFE_INTEGER],
        ])('parses "%s" as %d', (value, expected) => {
            const env = new Environment(sourceFrom(wire([['TIMEOUT', value]])));

            expect(env.integer('TIMEOUT', 5000)).toBe(expected);
        });

        it('keeps the sign of "-0"', () => {
            const env = new Environment(sourceFrom(wire([['OFFSET', '-0']])));

            expect(Object.is(env.integer('OFFSET', 1), -0)).toBe(true);
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

    describe('empty values', () => {
        const blank = new Environment(sourceFrom(wire([['BLANK', '']])));

        it.each([
            ['string', () => blank.string('BLANK', 'fallback'), 'fallback'],
            ['boolean', () => blank.boolean('BLANK', true), true],
            ['integer', () => blank.integer('BLANK', 80), 80],
            ['json', () => blank.json<readonly string[]>('BLANK', ['en-GB']), ['en-GB']],
        ])('%s() treats an empty string as not set', (_, read, expected) => {
            expect(read()).toStrictEqual(expected);
        });

        it.each([
            ['string', () => blank.string('BLANK')],
            ['boolean', () => blank.boolean('BLANK')],
            ['integer', () => blank.integer('BLANK')],
            ['json', () => blank.json('BLANK')],
        ])('%s() resolves an empty string to undefined without a fallback', (_, read) => {
            expect(read()).toBeUndefined();
        });

        it.each([
            ['0', false],
            ['false', false],
        ])('keeps the non-empty "%s" as a set value', (value, flag) => {
            const env = new Environment(sourceFrom(wire([['FLAG', value]])));

            expect(env.string('FLAG', 'fallback')).toBe(value);
            expect(env.boolean('FLAG', true)).toBe(flag);
        });
    });

    describe('overloads', () => {
        const env = new Environment(emptySource());

        it('narrows string() to string only with a definite fallback', () => {
            expectTypeOf(env.string('KEY')).toEqualTypeOf<string | undefined>();
            expectTypeOf(env.string('KEY', 'x')).toEqualTypeOf<string>();
            expectTypeOf(env.string('KEY', optional('x'))).toEqualTypeOf<string | undefined>();
        });

        it('narrows boolean() to boolean only with a definite fallback', () => {
            expectTypeOf(env.boolean('KEY')).toEqualTypeOf<boolean | undefined>();
            expectTypeOf(env.boolean('KEY', true)).toEqualTypeOf<boolean>();
            expectTypeOf(env.boolean('KEY', optional(true))).toEqualTypeOf<boolean | undefined>();
        });

        it('narrows integer() to number only with a definite fallback', () => {
            expectTypeOf(env.integer('KEY')).toEqualTypeOf<number | undefined>();
            expectTypeOf(env.integer('KEY', 1)).toEqualTypeOf<number>();
            expectTypeOf(env.integer('KEY', optional(1))).toEqualTypeOf<number | undefined>();
        });

        it('narrows json() to T only with a definite fallback', () => {
            expectTypeOf(env.json<string[]>('KEY')).toEqualTypeOf<string[] | undefined>();
            expectTypeOf(env.json<string[]>('KEY', [])).toEqualTypeOf<string[]>();
            expectTypeOf(env.json<string[]>('KEY', optional([]))).toEqualTypeOf<string[] | undefined>();
        });

        it.each([
            ['string', () => env.string('KEY', optional('x')), 'x'],
            ['boolean', () => env.boolean('KEY', optional(true)), true],
            ['integer', () => env.integer('KEY', optional(1)), 1],
            ['json', () => env.json<readonly string[]>('KEY', optional(['en-GB'])), ['en-GB']],
        ])('%s() returns an optional fallback that holds a value', (_, read, expected) => {
            expect(read()).toStrictEqual(expected);
        });
    });
});
