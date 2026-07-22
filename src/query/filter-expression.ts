/**
 * Filter-expression types for the laravel-api-toolkit 2.x wire protocol.
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
 * ### Equality (shorthand)
 * ```json
 * { "name": "Alice" }
 * ```
 *
 * ### Comparison operators
 * ```json
 * { "age": { "$ge": 18, "$le": 65 } }
 * ```
 * All operator keys are `$`-prefixed: `$eq`, `$neq`, `$gt`, `$lt`, `$ge`,
 * `$le`, `$like`, `$in`, `$between`, `$contains`, `$null`, `$notNull`.
 *
 * ### Logical groups
 * ```json
 * { "$and": { "status": "active", "role": "admin" } }
 * { "$or":  { "name": { "$like": "alice" }, "email": { "$like": "alice" } } }
 * ```
 * Protocol limitation: each field may appear **once** inside a group object.
 *
 * ### Relation filters (nested)
 * ```json
 * { "posts": { "title": { "$like": "news" } } }
 * ```
 *
 * ### Relation existence
 * ```json
 * { "$has": ["posts", "comments"] }
 * { "$has": { "posts": { "published": true } } }
 * { "$has": { "posts": {}, "comments": { "title": "X" } } }
 * ```
 * The three forms are a bare array, a conditioned object, and a mix - use `{}`
 * for a bare relation inside the object form.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/** A primitive scalar value accepted as a filter operand. */
export type FilterScalar = string | number | boolean;

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

    /** Wildcard pattern match. */
    readonly $like?: string;

    /** Value is one of the given set. */
    readonly $in?: readonly FilterScalar[];

    /** Value falls within the inclusive bounds. */
    readonly $between?: readonly [FilterScalar, FilterScalar];

    /** Field contains the given value or values. */
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
