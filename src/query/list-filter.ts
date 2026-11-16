/**
 * Filter mappers for the list-query layer.
 *
 * Each factory function in the {@link filter} namespace returns a
 * {@link ListFilter} that knows how to apply one kind of filter condition to an
 * {@link ApiQuery}. Screen developers choose a factory by name and provide a
 * plain value; all wire-protocol knowledge stays here.
 *
 * Dot-path fields (e.g. `'posts.author.name'`) are compiled to nested
 * `whereRelation` calls so the full relation chain is expressed correctly on
 * the wire.
 *
 * Every value a mapper receives is a real condition: `''` and `false` filter
 * for that value. Clear a filter by not applying it.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { ApiQuery } from './api-query';
import type { FilterScalar } from './filter-expression';

/**
 * A typed filter that knows how to apply a concrete value to an
 * {@link ApiQuery}.
 *
 * Instances are created by the {@link filter} factory namespace and registered
 * in a {@link ListQueryDefinition}. Screen developers never implement this
 * interface directly.
 *
 * @typeParam Value - the plain value type the screen passes in
 */
export interface ListFilter<Value> {
    /**
     * Apply a concrete value to a query, returning the updated query.
     *
     * @param query - the query to extend
     * @param value - the concrete filter value chosen by the screen
     * @returns the updated query with the filter applied
     */
    apply(query: ApiQuery, value: Value): ApiQuery;
}

/**
 * Apply a leaf filter condition, walking dot-path segments as relation nests.
 *
 * A plain field name (no dot) is passed directly to `applyLeaf`. A dot-
 * separated path like `'posts.author.name'` recurses through
 * `query.whereRelation` so the backend receives the correct nested filter tree.
 *
 * @param query - the query to extend
 * @param field - the field path, optionally dot-separated
 * @param applyLeaf - function that applies the condition to the innermost query
 * @returns the updated query with the nested or plain filter applied
 */
function applyDotPath(query: ApiQuery, field: string, applyLeaf: (q: ApiQuery, leaf: string) => ApiQuery): ApiQuery {
    const dot = field.indexOf('.');

    if (dot === -1) {
        return applyLeaf(query, field);
    }

    const relation = field.slice(0, dot);
    const rest = field.slice(dot + 1);

    return query.whereRelation(relation, sub => applyDotPath(sub, rest, applyLeaf));
}

/**
 * Factory namespace of {@link ListFilter} constructors.
 *
 * Every member accepts an API field path (optionally dot-separated for relation
 * nesting) and returns a {@link ListFilter} for the appropriate value type.
 * Import this object and use `filter.equals(...)` etc. in your
 * {@link ListQueryDefinition}.
 *
 * @example
 * ```ts
 * const definition = defineListQuery({
 *     filters: {
 *         status: filter.equals('status'),
 *         roles:  filter.anyOf('role'),
 *     },
 *     search: filter.search(),
 * });
 * ```
 */
export const filter = Object.freeze({
    /**
     * Strict equality filter (`field = value`).
     *
     * @param field - the API field path, optionally dot-separated
     * @returns a {@link ListFilter} that emits a scalar equality condition
     */
    equals(field: string): ListFilter<FilterScalar> {
        return {
            apply(query, value) {
                return applyDotPath(query, field, (q, leaf) => q.where(leaf, value));
            },
        };
    },

    /**
     * Membership filter (`field IN (values)`). An empty list applies no filter,
     * as an empty `$in` would match nothing.
     *
     * @param field - the API field path, optionally dot-separated
     * @returns a {@link ListFilter} that emits a `$in` condition
     */
    anyOf(field: string): ListFilter<readonly FilterScalar[]> {
        return {
            apply(query, value) {
                if (value.length === 0) {
                    return query;
                }

                return applyDotPath(query, field, (q, leaf) => q.whereIn(leaf, value));
            },
        };
    },

    /**
     * Range filter (`low <= field <= high`).
     *
     * @param field - the API field path, optionally dot-separated
     * @returns a {@link ListFilter} that emits a `$between` condition
     */
    between(field: string): ListFilter<readonly [FilterScalar, FilterScalar]> {
        return {
            apply(query, value) {
                return applyDotPath(query, field, (q, leaf) => q.whereBetween(leaf, value));
            },
        };
    },

    /**
     * Lower-bound filter (`field >= value`).
     *
     * @param field - the API field path, optionally dot-separated
     * @returns a {@link ListFilter} that emits a `$ge` condition
     */
    atLeast(field: string): ListFilter<FilterScalar> {
        return {
            apply(query, value) {
                return applyDotPath(query, field, (q, leaf) => q.where(leaf, '$ge', value));
            },
        };
    },

    /**
     * Upper-bound filter (`field <= value`).
     *
     * @param field - the API field path, optionally dot-separated
     * @returns a {@link ListFilter} that emits a `$le` condition
     */
    atMost(field: string): ListFilter<FilterScalar> {
        return {
            apply(query, value) {
                return applyDotPath(query, field, (q, leaf) => q.where(leaf, '$le', value));
            },
        };
    },

    /**
     * Boolean equality filter. `false` is treated as a real filter value, not a
     * clear signal.
     *
     * @param field - the API field path, optionally dot-separated
     * @returns a {@link ListFilter} that emits a boolean equality condition
     */
    boolean(field: string): ListFilter<boolean> {
        return {
            apply(query, value) {
                return applyDotPath(query, field, (q, leaf) => q.where(leaf, value));
            },
        };
    },

    /**
     * Null-presence filter.
     *
     * `true` → field must not be null (`$notNull`); `false` → field must be
     * null (`$null`).
     *
     * @param field - the API field path, optionally dot-separated
     * @returns a {@link ListFilter} that emits a `$notNull` or `$null`
     * condition
     */
    present(field: string): ListFilter<boolean> {
        return {
            apply(query, value) {
                return applyDotPath(query, field, (q, leaf) => (value ? q.whereNotNull(leaf) : q.whereNull(leaf)));
            },
        };
    },

    /**
     * JSON containment filter (`field $contains value`). An array must all be
     * contained (all-of); a comma-separated string matches any one item
     * (any-of).
     *
     * @param field - the API field path, optionally dot-separated
     * @returns a {@link ListFilter} that emits a `$contains` condition
     */
    contains(field: string): ListFilter<FilterScalar | readonly FilterScalar[]> {
        return {
            apply(query, value) {
                return applyDotPath(query, field, (q, leaf) => q.whereContains(leaf, value));
            },
        };
    },

    /**
     * Free-text search over the fields the resource declares searchable,
     * emitted as the top-level `search` parameter. An empty or whitespace-only
     * term clears the search.
     *
     * @returns a {@link ListFilter} that sets the query's search term
     */
    search(): ListFilter<string> {
        return {
            apply(query, value) {
                return query.search(value);
            },
        };
    },

    /**
     * Escape hatch for filters that do not fit the standard factory shapes.
     *
     * @param apply - a function that applies the filter to the query
     * @returns a {@link ListFilter} delegating directly to the provided
     * function
     * @typeParam Value - the plain value type the screen passes in
     */
    custom<Value>(apply: (query: ApiQuery, value: Value) => ApiQuery): ListFilter<Value> {
        return { apply };
    },
});
