/**
 * Compile-time contract tests for the filter-expression types.
 *
 * The exported types are pure structural declarations, so their contract is
 * assignability - enforced here through type-level assertions the typecheck
 * gate fails on drift. Runtime behaviour over these shapes is covered in
 * api-query.test.ts.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expectTypeOf, it } from 'vitest';

import type { FilterOperators, FilterScalar, FilterTree } from './filter-expression';

describe('FilterScalar', () => {
    it('accepts strings, numbers and booleans, and rejects objects', () => {
        expectTypeOf<string>().toExtend<FilterScalar>();
        expectTypeOf<number>().toExtend<FilterScalar>();
        expectTypeOf<boolean>().toExtend<FilterScalar>();
        expectTypeOf<{ nested: true }>().not.toExtend<FilterScalar>();
    });
});

describe('FilterOperators', () => {
    it('accepts fully-populated and partial operator maps', () => {
        expectTypeOf<{
            // biome-ignore-start lint/style/useNamingConvention: toolkit keys
            $eq: string;
            $neq: string;
            $gt: number;
            $lt: number;
            $ge: number;
            $le: number;
            $like: string;
            $in: string[];
            $between: [number, number];
            $contains: string;
            $null: true;
            $notNull: true;
            // biome-ignore-end lint/style/useNamingConvention: toolkit keys
        }>().toExtend<FilterOperators>();
        // biome-ignore lint/style/useNamingConvention: toolkit keys
        expectTypeOf<{ $ge: number }>().toExtend<FilterOperators>();
    });

    it('rejects unknown operator keys', () => {
        // biome-ignore lint/style/useNamingConvention: toolkit keys
        expectTypeOf<{ $regex: string }>().not.toExtend<FilterOperators>();
    });
});

describe('FilterTree', () => {
    it('accepts field conditions, operator maps and group keys', () => {
        expectTypeOf<{
            name: string;
            // biome-ignore-start lint/style/useNamingConvention: toolkit keys
            age: { $ge: number };
            $and: { status: string };
            // biome-ignore-end lint/style/useNamingConvention: toolkit keys
        }>().toExtend<FilterTree>();
    });
});
