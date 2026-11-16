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

import type { ApiQuery } from './api-query';
import type {
    FilterDocumentBuilder,
    FilterOperators,
    FilterScalar,
    FilterTree,
    ScalarOperator,
    SortDirection,
} from './filter-expression';

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
            Record<'$eq' | '$neq', string> &
                Record<'$gt' | '$lt' | '$ge' | '$le', number> &
                Record<'$in', string[]> &
                Record<'$between', [number, number]> &
                Record<'$contains', string> &
                Record<'$null' | '$notNull', true>
        >().toExtend<FilterOperators>();
        expectTypeOf<Record<'$ge', number>>().toExtend<FilterOperators>();
    });

    it('rejects unknown operator keys', () => {
        expectTypeOf<Record<'$regex', string>>().not.toExtend<FilterOperators>();
    });

    it('rejects the removed pattern-match operator', () => {
        expectTypeOf<Record<'$like', string>>().not.toExtend<FilterOperators>();
    });
});

describe('FilterTree', () => {
    it('accepts field conditions, operator maps and group lists', () => {
        expectTypeOf<
            Record<'name', string> &
                Record<'age', Record<'$ge', number>> &
                Record<'$and', Array<Record<'status', string>>>
        >().toExtend<FilterTree>();
    });
});

describe('ScalarOperator', () => {
    it('accepts the comparison operators and rejects the list operators', () => {
        expectTypeOf<'$eq' | '$neq' | '$gt' | '$lt' | '$ge' | '$le'>().toEqualTypeOf<ScalarOperator>();
        expectTypeOf<'$in'>().not.toExtend<ScalarOperator>();
    });
});

describe('FilterDocumentBuilder', () => {
    it('maps a fresh query to the query carrying the document', () => {
        expectTypeOf<FilterDocumentBuilder>().toEqualTypeOf<(query: ApiQuery) => ApiQuery>();
    });
});

describe('SortDirection', () => {
    it('accepts ascending and descending only', () => {
        expectTypeOf<'asc' | 'desc'>().toEqualTypeOf<SortDirection>();
    });
});
