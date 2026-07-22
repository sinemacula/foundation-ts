/**
 * Definition schema for the list-query layer.
 *
 * Module authors call {@link defineListQuery} once per resource list to declare
 * what filters, search, sort columns, and base shaping that list supports.
 * Screen developers receive the definition and interact with it only through
 * {@link useListQuery} - they never read these fields directly.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { ApiQuery } from './api-query';
import type { ListFilter } from './list-filter';

/**
 * Extracts the value type `V` from a {@link ListFilter}<V>.
 *
 * Used by {@link useListQuery} to enforce that `setFilter` is called with the
 * correct value type for each named filter key.
 *
 * @typeParam Filter - a concrete {@link ListFilter} type
 */
export type FilterValueOf<Filter> = Filter extends ListFilter<infer V> ? V : never;

/**
 * The default sort column and direction applied when no explicit sort is set.
 */
export interface SortDefault {
    /** The column name to sort by. */
    readonly column: string;

    /** The sort direction. */
    readonly direction: 'asc' | 'desc';
}

/**
 * The frozen declaration of a resource list's query capabilities.
 *
 * Created by {@link defineListQuery} and passed to {@link useListQuery}. Every
 * field is optional so simple lists need only declare what they use.
 *
 * @typeParam Filters - a record mapping screen-vocabulary filter names to their
 * typed {@link ListFilter} implementations
 */
export interface ListQueryDefinition<Filters extends Record<string, ListFilter<never>> = Record<string, never>> {
    /** Named filters the screen may set, keyed by the screen's vocabulary. */
    readonly filters?: Filters;

    /** Free-text search mapping. When set, calling `search(term)` on the resulting {@link ListQuery} applies this filter with the term as its value. */
    readonly search?: ListFilter<string>;

    /** The columns the screen may sort by. When set, `sortBy` rejects any column not in this list by throwing a descriptive `Error`. When `undefined`, all columns are accepted. */
    readonly sortable?: readonly string[];

    /** The sort applied when no explicit sort has been chosen. Omit to emit no `order` parameter when the screen has not called `sortBy`. */
    readonly defaultSort?: SortDefault;

    /** Number of items per page emitted as the `limit` parameter; defaults to 25. */
    readonly pageSize?: number;

    /** Always-applied base shaping, compiled before any screen-set filters or sorts. */
    readonly base?: (query: ApiQuery) => ApiQuery;
}

/**
 * Declare and freeze a list-query definition.
 *
 * Returns the definition unchanged but frozen so that accidental mutation at
 * runtime is caught immediately. Pass the return value to {@link useListQuery}.
 *
 * @param definition - the list configuration
 * @returns the same definition, frozen
 * @typeParam Filters - inferred from the `filters` record; flows through to
 * `useListQuery` so that `setFilter` is key- and value-typed
 */
export function defineListQuery<Filters extends Record<string, ListFilter<never>>>(
    definition: ListQueryDefinition<Filters>,
): ListQueryDefinition<Filters> {
    return Object.freeze(definition);
}
