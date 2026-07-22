/**
 * Unit tests for deep-freeze.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { deepFreeze } from './deep-freeze';

describe('deepFreeze', () => {
    it('returns a primitive number unchanged', () => {
        expect(deepFreeze(42)).toBe(42);
    });

    it('returns a primitive string unchanged', () => {
        expect(deepFreeze('hello')).toBe('hello');
    });

    it('returns a primitive boolean unchanged', () => {
        expect(deepFreeze(true)).toBe(true);
    });

    it('returns null unchanged', () => {
        expect(deepFreeze(null)).toBeNull();
    });

    it('returns undefined unchanged', () => {
        expect(deepFreeze(undefined)).toBeUndefined();
    });

    it('freezes a flat object', () => {
        const obj = { a: 1, b: 'two' };

        deepFreeze(obj);

        expect(Object.isFrozen(obj)).toBe(true);
    });

    it('returns the same object reference', () => {
        const obj = { x: 1 };
        const result = deepFreeze(obj);

        expect(result).toBe(obj);
    });

    it('freezes nested objects recursively', () => {
        const inner = { c: 3 };
        const outer = { a: 1, nested: inner };

        deepFreeze(outer);

        expect(Object.isFrozen(outer)).toBe(true);
        expect(Object.isFrozen(inner)).toBe(true);
    });

    it('freezes arrays and their object elements', () => {
        const item = { v: 1 };
        const arr = [item, 2, 'three'];

        deepFreeze(arr);

        expect(Object.isFrozen(arr)).toBe(true);
        expect(Object.isFrozen(item)).toBe(true);
    });

    it('skips an already-frozen branch without re-freezing', () => {
        const child = Object.freeze({ y: 99 });
        const parent = { child };

        deepFreeze(parent);

        expect(Object.isFrozen(parent)).toBe(true);
        expect(Object.isFrozen(child)).toBe(true);
    });

    it('freezes deeply nested structures three levels deep', () => {
        const level3 = { deep: true };
        const level2 = { level3 };
        const level1 = { level2 };

        deepFreeze(level1);

        expect(Object.isFrozen(level1)).toBe(true);
        expect(Object.isFrozen(level2)).toBe(true);
        expect(Object.isFrozen(level3)).toBe(true);
    });
});
