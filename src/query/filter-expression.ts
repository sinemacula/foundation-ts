/**
 * Filter-tree and operand types for the laravel-api-toolkit 2.x filter grammar.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { ApiQuery } from './api-query';

/** A primitive scalar value accepted as a filter operand. */
export type FilterScalar = string | number | boolean;

/** The comparison operators accepted by the three-argument `where`. */
export type ScalarOperator = '$eq' | '$neq' | '$gt' | '$lt' | '$ge' | '$le';

/** Builds one filter document on the fresh query it is given. */
export type FilterDocumentBuilder = (query: ApiQuery) => ApiQuery;

/** The direction of one sort entry. */
export type SortDirection = 'asc' | 'desc';

/**
 * Comparison and membership operators supported by the toolkit wire protocol.
 *
 * Multiple operators on the same field are merged into one object:
 * `{ "$ge": 18, "$le": 65 }`.
 */
export interface FilterOperators {
    // biome-ignore-start lint/style/useNamingConvention: toolkit keys

    /** Equality match. */
    readonly $eq?: FilterScalar;

    /** Inequality match. */
    readonly $neq?: FilterScalar;

    /** Strictly greater than. */
    readonly $gt?: FilterScalar;

    /** Strictly less than. */
    readonly $lt?: FilterScalar;

    /** Greater than or equal. */
    readonly $ge?: FilterScalar;

    /** Less than or equal. */
    readonly $le?: FilterScalar;

    /** Value is one of the given set. */
    readonly $in?: readonly FilterScalar[];

    /** Value falls within the inclusive bounds. */
    readonly $between?: readonly [FilterScalar, FilterScalar];

    /** Containment: an array is all-of, a comma-separated string any-of. */
    readonly $contains?: FilterScalar | readonly FilterScalar[];

    /** Field is null. */
    readonly $null?: true;

    /** Field is not null. */
    readonly $notNull?: true;

    // biome-ignore-end lint/style/useNamingConvention: toolkit keys
}

/**
 * The filter tree {@link ApiQuery} assembles and sends, JSON-encoded, as the
 * `filters` parameter. It is a loose record because a recursive type collides
 * with `noUncheckedIndexedAccess`; build it through the typed builder methods.
 */
export type FilterTree = Record<string, unknown>;
