/**
 * Unit tests for is-record.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { isRecord } from './is-record';

describe('isRecord', () => {
    it.each([
        ['a plain object', { a: 1 }],
        ['an empty object', {}],
        ['a nested plain object', { nested: { a: 1 } }],
    ])('returns true for %s', (_, value) => {
        expect(isRecord(value)).toBe(true);
    });

    it.each([
        ['null', null],
        ['an array', [1, 2, 3]],
        ['an empty array', []],
        ['a string', 'hello'],
        ['a number', 42],
        ['a boolean', false],
        ['undefined', undefined],
    ])('returns false for %s', (_, value) => {
        expect(isRecord(value)).toBe(false);
    });
});
