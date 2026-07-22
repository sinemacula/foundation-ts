/**
 * Unit tests for is-record.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { isRecord } from './is-record';

describe('isRecord', () => {
    it('returns true for a plain object', () => {
        expect(isRecord({ a: 1 })).toBe(true);
    });

    it('returns true for an empty object', () => {
        expect(isRecord({})).toBe(true);
    });

    it('returns false for null', () => {
        expect(isRecord(null)).toBe(false);
    });

    it('returns false for an array', () => {
        expect(isRecord([1, 2, 3])).toBe(false);
    });

    it('returns false for an empty array', () => {
        expect(isRecord([])).toBe(false);
    });

    it('returns false for a string', () => {
        expect(isRecord('hello')).toBe(false);
    });

    it('returns false for a number', () => {
        expect(isRecord(42)).toBe(false);
    });

    it('returns false for a boolean', () => {
        expect(isRecord(false)).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(isRecord(undefined)).toBe(false);
    });

    it('returns true for a nested plain object', () => {
        expect(isRecord({ nested: { a: 1 } })).toBe(true);
    });
});
