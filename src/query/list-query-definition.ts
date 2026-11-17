/**
 * Definition schema for the list-query layer.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { ApiQuery } from './api-query';
import type { SortDirection } from './filter-expression';
import type { ListFilter } from './list-filter';

/**
 * Extracts the value type `V` from a {@link ListFilter}<V>, which the platform
 * list-query bindings use to type `setFilter` per filter key.
 */
export type FilterValueOf<Filter> = Filter extends ListFilter<infer V> ? V : never;

/**
 * The default sort column and direction applied when no explicit sort is set.
 */
export interface SortDefault {
    /** The column name to sort by. */
    readonly column: string;

    /** The sort direction. */
    readonly direction: SortDirection;
}

/**
 * The frozen declaration of a resource list's query capabilities, created by
 * {@link defineListQuery} and consumed by the platform list-query bindings.
 *
 * @typeParam Filters - a record mapping screen-vocabulary filter names to their
 * typed {@link ListFilter} implementations
 */
export interface ListQueryDefinition<Filters extends Record<string, ListFilter<never>> = Record<string, never>> {
    /** Named filters the screen may set, keyed by the screen's vocabulary. */
    readonly filters?: Filters;

    /** Free-text search mapping, usually `filter.search()`, applied with the term `search(term)` receives. */
    readonly search?: ListFilter<string>;

    /** The columns the screen may sort by; `sortBy` throws on any other. Omit to accept every column. */
    readonly sortable?: readonly string[];

    /** The sort applied until the screen calls `sortBy`; omit to emit no `order` parameter. */
    readonly defaultSort?: SortDefault;

    /** Number of items per page emitted as the `limit` parameter; defaults to 25. */
    readonly pageSize?: number;

    /** Always-applied base shaping, compiled before any screen-set filters or sorts. */
    readonly base?: (query: ApiQuery) => ApiQuery;
}

/**
 * Declare a list-query definition for the platform's list-query binding.
 *
 * @returns the same definition, frozen so accidental mutation fails fast
 * @typeParam Filters - inferred from the `filters` record; flows through to the
 * list-query binding so that `setFilter` is key- and value-typed
 */
export function defineListQuery<Filters extends Record<string, ListFilter<never>>>(
    definition: ListQueryDefinition<Filters>,
): ListQueryDefinition<Filters> {
    return Object.freeze(definition);
}
