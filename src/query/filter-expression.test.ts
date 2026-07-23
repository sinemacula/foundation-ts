/**
 * Unit tests for filter-expression type contracts.
 *
 * This file validates that the exported types accept and reject values as
 * intended. Runtime assertions are minimal because the types are pure
 * structural declarations; the real coverage lives in api-query.test.ts.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import type { FilterOperators, FilterScalar, FilterTree } from './filter-expression';

describe('FilterScalar', () => {
    it('accepts a string', () => {
        const value: FilterScalar = 'hello';

        expect(typeof value).toBe('string');
    });

    it('accepts a number', () => {
        const value: FilterScalar = 42;

        expect(typeof value).toBe('number');
    });

    it('accepts a boolean', () => {
        const value: FilterScalar = true;

        expect(typeof value).toBe('boolean');
    });
});

describe('FilterOperators', () => {
    it('accepts a fully-populated operator map', () => {
        const ops: FilterOperators = {
            // biome-ignore-start lint/style/useNamingConvention: toolkit keys
            $eq: 'Alice',
            $neq: 'Bob',
            $gt: 18,
            $lt: 65,
            $ge: 18,
            $le: 65,
            $like: 'ali',
            $in: ['a', 'b'],
            $between: [1, 10],
            $contains: 'x',
            $null: true,
            $notNull: true,
            // biome-ignore-end lint/style/useNamingConvention: toolkit keys
        };

        expect(ops.$eq).toBe('Alice');
        expect(ops.$in).toEqual(['a', 'b']);
        expect(ops.$between).toEqual([1, 10]);
        expect(ops.$null).toBe(true);
        expect(ops.$notNull).toBe(true);
    });

    it('accepts a partial operator map', () => {
        // biome-ignore lint/style/useNamingConvention: toolkit keys
        const ops: FilterOperators = { $ge: 18 };

        expect(ops.$ge).toBe(18);
        expect(ops.$le).toBeUndefined();
    });
});

describe('FilterTree', () => {
    it('accepts an arbitrary record of unknown values', () => {
        const tree: FilterTree = {
            name: 'Alice',
            // biome-ignore-start lint/style/useNamingConvention: toolkit keys
            age: { $ge: 18 },
            $and: { status: 'active' },
            // biome-ignore-end lint/style/useNamingConvention: toolkit keys
        };

        expect(tree['name']).toBe('Alice');
    });
});
