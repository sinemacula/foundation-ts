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
        expectTypeOf<Record<'nested', true>>().not.toExtend<FilterScalar>();
    });
});

describe('FilterOperators', () => {
    it('accepts fully-populated and partial operator maps', () => {
        expectTypeOf<
            Record<'$eq' | '$neq' | '$like' | '$contains', string> &
                Record<'$gt' | '$lt' | '$ge' | '$le', number> &
                Record<'$in', string[]> &
                Record<'$between', [number, number]> &
                Record<'$null' | '$notNull', true>
        >().toExtend<FilterOperators>();
        expectTypeOf<Record<'$ge', number>>().toExtend<FilterOperators>();
    });

    it('rejects unknown operator keys', () => {
        expectTypeOf<Record<'$regex', string>>().not.toExtend<FilterOperators>();
    });
});

describe('FilterTree', () => {
    it('accepts field conditions, operator maps and group keys', () => {
        expectTypeOf<
            Record<'name', string> & Record<'age', Record<'$ge', number>> & Record<'$and', Record<'status', string>>
        >().toExtend<FilterTree>();
    });
});
