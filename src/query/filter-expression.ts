/**
 * Filter-expression types for the laravel-api-toolkit 2.x wire protocol, and
 * the operand types the {@link ApiQuery} builder signatures accept.
 *
 * These types describe the **shape** of the filter tree that {@link ApiQuery}
 * assembles and JSON-encodes into the `filters` URL query parameter. A fully
 * recursive TypeScript type would collide with the index-signature restrictions
 * that `noUncheckedIndexedAccess` imposes, so the outermost `FilterTree` is a
 * loosely-typed `Record`; the builder methods on `ApiQuery` are the typed,
 * ergonomic surface.
 *
 * ## Supported tree shapes
 *
 * The entries of a filter document AND together at every depth.
 *
 * ### Equality (shorthand)
 * ```json
 * { "name": "Alice" }
 * ```
 * Any scalar is a real condition, including `""`, `0` and `false`.
 *
 * ### Comparison operators
 * ```json
 * { "age": { "$ge": 18, "$le": 65 } }
 * ```
 * All operator keys are `$`-prefixed: `$eq`, `$neq`, `$gt`, `$lt`, `$ge`,
 * `$le`, `$in`, `$between`, `$contains`, `$null`, `$notNull`. Free-text
 * matching is not a filter operator; it is the separate `search` parameter.
 *
 * ### Logical groups
 * ```json
 * { "$or": [{ "role": "admin", "status": "active" }, { "role": "owner" }] }
 * { "$and": [{ "$or": [{ "a": 1 }, { "b": 2 }] }, { "$or": [{ "c": 3 }, { "d": 4 }] }] }
 * ```
 * A group is a non-empty list of non-empty documents. Each document is grouped
 * on its own, its keys ANDed, and the documents joined by AND or OR.
 *
 * ### Relation filters (nested)
 * ```json
 * { "posts": { "title": "News", "published": true } }
 * ```
 * Every condition in one relation document must hold for the same related
 * row; split them across `$and` documents to let different rows match.
 *
 * ### Relation existence
 * ```json
 * { "$has": ["posts", "comments"] }
 * { "$has": { "posts": { "published": true } } }
 * { "$has": { "posts": {}, "comments": { "title": "X" } } }
 * ```
 * The three forms are a bare list, a conditioned map, and a mix - use `{}` for
 * a bare relation inside the map form. Two `$hasnt` documents on one relation
 * are separate conditions, so the second stands as its own `$and` document.
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
 * The assembled filter tree passed to `JSON.stringify` and sent as the
 * `filters` query parameter.
 *
 * Assembled exclusively by {@link ApiQuery}; callers interact through the typed
 * builder API, not by constructing this record directly.
 */
export type FilterTree = Record<string, unknown>;
