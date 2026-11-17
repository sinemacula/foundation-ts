/**
 * Filter mappers for the list-query layer.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { ApiQuery } from './api-query';
import type { FilterScalar } from './filter-expression';

/**
 * A typed filter that applies a screen's value to an {@link ApiQuery}, created
 * by the {@link filter} factories.
 *
 * @typeParam Value - the plain value type the screen passes in
 */
export interface ListFilter<Value> {
    /**
     * Apply a concrete value to a query, returning the updated query.
     */
    apply(query: ApiQuery, value: Value): ApiQuery;
}

/**
 * Apply a leaf condition to `field`, nesting each dot-separated segment before
 * the last through `whereRelation`.
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
 * Field factories take an API field path, dot-separated to nest through
 * relations (`'posts.author.name'`). Every value a filter receives is a real
 * condition: `''` and `false` filter for that value, so clear a filter by not
 * applying it.
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
     */
    atMost(field: string): ListFilter<FilterScalar> {
        return {
            apply(query, value) {
                return applyDotPath(query, field, (q, leaf) => q.where(leaf, '$le', value));
            },
        };
    },

    /**
     * Boolean equality filter.
     */
    boolean(field: string): ListFilter<boolean> {
        return {
            apply(query, value) {
                return applyDotPath(query, field, (q, leaf) => q.where(leaf, value));
            },
        };
    },

    /**
     * Null-presence filter: `true` requires a value (`$notNull`), `false`
     * requires null (`$null`).
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
     * @typeParam Value - the plain value type the screen passes in
     */
    custom<Value>(apply: (query: ApiQuery, value: Value) => ApiQuery): ListFilter<Value> {
        return { apply };
    },
});
