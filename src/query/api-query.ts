/**
 * Immutable fluent query builder for the laravel-api-toolkit 2.x wire protocol.
 *
 * `ApiQuery` is the organisation's structured-query surface over the API
 * toolkit - GraphQL-style shaping: filter, sort, paginate, sparse fields,
 * counts, and aggregates. Every method returns a **new** `ApiQuery` instance;
 * the original is never mutated, making it safe to share a base query across
 * multiple derived queries.
 *
 * ## Quick start
 * ```ts
 * const params = ApiQuery.create()
 *     .where('status', 'active')
 *     .where('age', '$ge', 18)
 *     .orderBy('name')
 *     .page(2)
 *     .limit(25)
 *     .fields(['id', 'name', 'email'])
 *     .toQueryParameters();
 * ```
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { QueryParameters } from '../http/http-client';
import type { FilterOperators, FilterScalar, FilterTree } from './filter-expression';

/**
 * The scalar comparison operators accepted by the two-argument `where`
 * overload.
 */
type ScalarOperator = '$eq' | '$neq' | '$gt' | '$lt' | '$ge' | '$le' | '$like';

/** An entry in the order list: column name and sort direction. */
interface OrderEntry {
    /** The column name to sort by. */
    readonly column: string;

    /** The sort direction. */
    readonly direction: 'asc' | 'desc';
}

/**
 * Internal, immutable state bag passed between `ApiQuery` instances.
 *
 * All collections are readonly arrays/records; mutations produce new objects.
 */
interface QueryState {
    /** The assembled filter tree. */
    readonly filters: FilterTree;

    /** The ordered list of sort entries. */
    readonly order: readonly OrderEntry[];

    /** The 1-based page number, or undefined when unset. */
    readonly pageNumber: number | undefined;

    /** The page size, or undefined when unset. */
    readonly limitNumber: number | undefined;

    /** The opaque cursor token, or undefined when unset. */
    readonly cursorToken: string | undefined;

    /** Whether cursor pagination is forced on. */
    readonly cursorPagination: boolean;

    /** The global sparse-field list, or undefined when unset. */
    readonly fieldsList: readonly string[] | undefined;

    /** Per-resource sparse-field lists keyed by resource. */
    readonly fieldsMap: Readonly<Record<string, readonly string[]>>;

    /** The global relation-count list, or undefined when unset. */
    readonly countsList: readonly string[] | undefined;

    /** Per-resource relation-count lists keyed by resource. */
    readonly countsMap: Readonly<Record<string, readonly string[]>>;

    /** Sum aggregates keyed by resource then relation. */
    readonly sumsMap: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;

    /** Average aggregates keyed by resource then relation. */
    readonly averagesMap: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

/** The empty initial state. */
const EMPTY_STATE: QueryState = {
    filters: {},
    order: [],
    pageNumber: undefined,
    limitNumber: undefined,
    cursorToken: undefined,
    cursorPagination: false,
    fieldsList: undefined,
    fieldsMap: {},
    countsList: undefined,
    countsMap: {},
    sumsMap: {},
    averagesMap: {},
};

/**
 * Merge a `FilterOperators` patch into an existing field entry.
 *
 * When the existing entry is already an operator map, the two objects are
 * merged. When it is a scalar equality value (or undefined), the patch replaces
 * it entirely.
 *
 * @param existing - the current value stored under the field key
 * @param patch - the operator map to merge or replace with
 * @returns the merged or replaced operator map
 */
function mergeOperators(existing: unknown, patch: FilterOperators): FilterOperators {
    if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
        return { ...(existing as FilterOperators), ...patch };
    }

    return patch;
}

/**
 * Build a single-operator filter patch without a literal operator key.
 *
 * @param operator - the wire-protocol operator (for example `$in`)
 * @param value - the operand stored under the operator
 * @returns a one-entry operator map
 */
function operatorPatch(operator: string, value: unknown): FilterOperators {
    return Object.fromEntries([[operator, value]]) as FilterOperators;
}

/**
 * Merge a nested object map entry.
 *
 * Used to combine repeated `$and` / `$or` group calls and `$has` / `$hasnt`
 * named-form calls into a single object rather than overwriting.
 *
 * @param existing - the current value stored under the group key
 * @param patch - the new fields to add into the group
 * @returns the merged group object
 */
function mergeGroup(existing: unknown, patch: FilterTree): FilterTree {
    if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
        return { ...(existing as FilterTree), ...patch };
    }

    return patch;
}

/**
 * Immutable fluent query builder for the laravel-api-toolkit 2.x API.
 *
 * Construct via {@link ApiQuery.create}; every method returns a new instance.
 *
 * Re-ordering note: `orderBy` for a column that already exists removes the
 * previous entry and appends a new one at the end. First-call position is not
 * preserved; the last call wins and the entry appears at the end of the sort
 * list.
 */
// Splitting this fluent immutable query builder would break method chaining.
// eslint-disable-next-line @sinemacula/max-methods-per-class -- fluent API
export class ApiQuery {
    /** The immutable state bag shared between derived instances. */
    readonly #state: QueryState;

    private constructor(state: QueryState) {
        this.#state = state;
    }

    /**
     * Create a new, empty `ApiQuery`.
     *
     * @returns a fresh query with no filters, ordering, or shaping
     */
    static create(): ApiQuery {
        return new ApiQuery(EMPTY_STATE);
    }

    // -------------------------------------------------------------------------
    // Filtering
    // -------------------------------------------------------------------------

    /**
     * Add an equality filter or an operator filter on `field`.
     *
     * @param field - the field name
     * @param value - the equality value (two-argument form)
     * @returns a new `ApiQuery` with the filter applied
     */
    where(field: string, value: FilterScalar): ApiQuery;

    /**
     * Add an operator filter on `field`.
     *
     * @param field - the field name
     * @param operator - the comparison operator
     * @param value - the operand value
     * @returns a new `ApiQuery` with the filter applied
     */
    where(field: string, operator: ScalarOperator, value: FilterScalar): ApiQuery;

    where(field: string, operatorOrValue: ScalarOperator | FilterScalar, value?: FilterScalar): ApiQuery {
        if (value === undefined) {
            // Two-argument equality form: replaces any existing operator map.
            return this.#withFilter(field, operatorOrValue as FilterScalar);
        }

        const operator = operatorOrValue as ScalarOperator;
        const patch = Object.fromEntries([[operator, value]]) as FilterOperators;

        return this.#withFilter(field, mergeOperators(this.#state.filters[field], patch));
    }

    /**
     * Add a `$in` filter: the field value must be one of `values`.
     *
     * @param field - the field name
     * @param values - the allowed scalar values
     * @returns a new `ApiQuery` with the filter applied
     */
    whereIn(field: string, values: readonly FilterScalar[]): ApiQuery {
        return this.#withFilter(field, mergeOperators(this.#state.filters[field], operatorPatch('$in', values)));
    }

    /**
     * Add a `$between` filter: the field value must be between the two bounds.
     *
     * @param field - the field name
     * @param pair - the inclusive lower and upper bounds
     * @returns a new `ApiQuery` with the filter applied
     */
    whereBetween(field: string, pair: readonly [FilterScalar, FilterScalar]): ApiQuery {
        return this.#withFilter(field, mergeOperators(this.#state.filters[field], operatorPatch('$between', pair)));
    }

    /**
     * Add a `$contains` filter.
     *
     * @param field - the field name
     * @param value - a scalar or array of scalars the field must contain
     * @returns a new `ApiQuery` with the filter applied
     */
    whereContains(field: string, value: FilterScalar | readonly FilterScalar[]): ApiQuery {
        return this.#withFilter(field, mergeOperators(this.#state.filters[field], operatorPatch('$contains', value)));
    }

    /**
     * Add a `$null: true` filter: the field must be null.
     *
     * @param field - the field name
     * @returns a new `ApiQuery` with the filter applied
     */
    whereNull(field: string): ApiQuery {
        return this.#withFilter(field, mergeOperators(this.#state.filters[field], operatorPatch('$null', true)));
    }

    /**
     * Add a `$notNull: true` filter: the field must not be null.
     *
     * @param field - the field name
     * @returns a new `ApiQuery` with the filter applied
     */
    whereNotNull(field: string): ApiQuery {
        return this.#withFilter(field, mergeOperators(this.#state.filters[field], operatorPatch('$notNull', true)));
    }

    // -------------------------------------------------------------------------
    // Relation filters
    // -------------------------------------------------------------------------

    /**
     * Nest a sub-query's filter tree under a relation key.
     *
     * ```ts
     * query.whereRelation('posts', q => q.where('published', true))
     * // → { posts: { published: true } }
     * ```
     *
     * @param relation - the relation name
     * @param build - callback that receives a fresh query and returns the built
     * query
     * @returns a new `ApiQuery` with the relation filter applied
     */
    whereRelation(relation: string, build: (query: ApiQuery) => ApiQuery): ApiQuery {
        const sub = build(ApiQuery.create());

        return this.#withFilter(relation, sub.#state.filters);
    }

    /**
     * Assert that the relation exists, optionally with conditions.
     *
     * Bare form (no build): adds the relation to the `$has` array (or object
     * with `{}` when a conditioned `$has` entry already exists). Conditioned
     * form: adds the relation with its filter tree to the `$has` object.
     *
     * @param relation - the relation name
     * @param build - optional callback to add filter conditions on the relation
     * @returns a new `ApiQuery` with the `$has` condition applied
     */
    whereHas(relation: string, build?: (query: ApiQuery) => ApiQuery): ApiQuery {
        return this.#applyHas('$has', relation, build);
    }

    /**
     * Assert that the relation does not exist, optionally with conditions.
     *
     * Same shape rules as {@link whereHas} but uses the `$hasnt` key.
     *
     * @param relation - the relation name
     * @param build - optional callback to add filter conditions on the relation
     * @returns a new `ApiQuery` with the `$hasnt` condition applied
     */
    whereHasNot(relation: string, build?: (query: ApiQuery) => ApiQuery): ApiQuery {
        return this.#applyHas('$hasnt', relation, build);
    }

    // -------------------------------------------------------------------------
    // Logical groups
    // -------------------------------------------------------------------------

    /**
     * Add an `$and` group containing the filters built by `build`.
     *
     * Repeated calls merge into the existing `$and` object rather than
     * replacing it.
     *
     * @param build - callback that receives a fresh query and returns the built
     * query
     * @returns a new `ApiQuery` with the `$and` group applied
     */
    andWhere(build: (query: ApiQuery) => ApiQuery): ApiQuery {
        const sub = build(ApiQuery.create());
        const merged = mergeGroup(this.#state.filters['$and'], sub.#state.filters);

        return this.#withFilter('$and', merged);
    }

    /**
     * Add an `$or` group containing the filters built by `build`.
     *
     * Repeated calls merge into the existing `$or` object rather than replacing
     * it.
     *
     * @param build - callback that receives a fresh query and returns the built
     * query
     * @returns a new `ApiQuery` with the `$or` group applied
     */
    orWhere(build: (query: ApiQuery) => ApiQuery): ApiQuery {
        const sub = build(ApiQuery.create());
        const merged = mergeGroup(this.#state.filters['$or'], sub.#state.filters);

        return this.#withFilter('$or', merged);
    }

    // -------------------------------------------------------------------------
    // Ordering
    // -------------------------------------------------------------------------

    /**
     * Append a sort entry for `column`.
     *
     * If `column` already appears in the order list its previous entry is
     * removed before the new entry is appended at the end.
     *
     * @param column - the column name to sort by
     * @param direction - sort direction; defaults to `'asc'`
     * @returns a new `ApiQuery` with the order entry appended
     */
    orderBy(column: string, direction: 'asc' | 'desc' = 'asc'): ApiQuery {
        const filtered = this.#state.order.filter(e => e.column !== column);

        return new ApiQuery({ ...this.#state, order: [...filtered, { column, direction }] });
    }

    /**
     * Request random ordering from the server.
     *
     * @returns a new `ApiQuery` with `random` appended to the order list
     */
    orderByRandom(): ApiQuery {
        return new ApiQuery({ ...this.#state, order: [...this.#state.order, { column: 'random', direction: 'asc' }] });
    }

    // -------------------------------------------------------------------------
    // Pagination
    // -------------------------------------------------------------------------

    /**
     * Set the page number (≥1).
     *
     * @param n - the 1-based page number
     * @returns a new `ApiQuery` with the page set
     */
    page(n: number): ApiQuery {
        return new ApiQuery({ ...this.#state, pageNumber: n });
    }

    /**
     * Set the page size (≥1).
     *
     * @param n - the maximum number of results per page
     * @returns a new `ApiQuery` with the limit set
     */
    limit(n: number): ApiQuery {
        return new ApiQuery({ ...this.#state, limitNumber: n });
    }

    /**
     * Set the cursor token for cursor-based pagination.
     *
     * @param token - the opaque cursor string returned by the server
     * @returns a new `ApiQuery` with the cursor set
     */
    cursor(token: string): ApiQuery {
        return new ApiQuery({ ...this.#state, cursorToken: token });
    }

    /**
     * Force cursor pagination by adding `pagination=cursor` to the parameters.
     *
     * @returns a new `ApiQuery` with cursor pagination enabled
     */
    useCursorPagination(): ApiQuery {
        return new ApiQuery({ ...this.#state, cursorPagination: true });
    }

    // -------------------------------------------------------------------------
    // Sparse fields
    // -------------------------------------------------------------------------

    /**
     * Request a comma-delimited global field list (`fields=name,email`).
     *
     * @param names - the field names to include
     * @returns a new `ApiQuery` with the global fields set
     */
    fields(names: readonly string[]): ApiQuery {
        return new ApiQuery({ ...this.#state, fieldsList: names });
    }

    /**
     * Request a per-resource field list (`fields[users]=name,email`).
     *
     * @param resource - the resource type name
     * @param names - the field names to include
     * @returns a new `ApiQuery` with the per-resource fields set
     */
    fieldsFor(resource: string, names: readonly string[]): ApiQuery {
        const fieldsMap = { ...this.#state.fieldsMap, [resource]: names };

        return new ApiQuery({ ...this.#state, fieldsMap });
    }

    /**
     * Request global relation counts (`counts=posts,comments`).
     *
     * @param relations - the relation names to count
     * @returns a new `ApiQuery` with the global counts set
     */
    counts(relations: readonly string[]): ApiQuery {
        return new ApiQuery({ ...this.#state, countsList: relations });
    }

    /**
     * Request per-resource relation counts (`counts[users]=posts,comments`).
     *
     * @param resource - the resource type name
     * @param relations - the relation names to count
     * @returns a new `ApiQuery` with the per-resource counts set
     */
    countsFor(resource: string, relations: readonly string[]): ApiQuery {
        const countsMap = { ...this.#state.countsMap, [resource]: relations };

        return new ApiQuery({ ...this.#state, countsMap });
    }

    // -------------------------------------------------------------------------
    // Aggregates
    // -------------------------------------------------------------------------

    /**
     * Request field sums for a resource relation
     * (`sums[account][transaction]=amount,fee`).
     *
     * @param resource - the parent resource type name
     * @param relation - the relation to aggregate over
     * @param fieldNames - the numeric fields to sum
     * @returns a new `ApiQuery` with the sum aggregate set
     */
    sumFor(resource: string, relation: string, fieldNames: readonly string[]): ApiQuery {
        const resourceMap = { ...this.#state.sumsMap[resource], [relation]: fieldNames };
        const sumsMap = { ...this.#state.sumsMap, [resource]: resourceMap };

        return new ApiQuery({ ...this.#state, sumsMap });
    }

    /**
     * Request field averages for a resource relation
     * (`averages[account][transaction]=amount,fee`).
     *
     * @param resource - the parent resource type name
     * @param relation - the relation to aggregate over
     * @param fieldNames - the numeric fields to average
     * @returns a new `ApiQuery` with the average aggregate set
     */
    averageFor(resource: string, relation: string, fieldNames: readonly string[]): ApiQuery {
        const resourceMap = { ...this.#state.averagesMap[resource], [relation]: fieldNames };
        const averagesMap = { ...this.#state.averagesMap, [resource]: resourceMap };

        return new ApiQuery({ ...this.#state, averagesMap });
    }

    // -------------------------------------------------------------------------
    // Output
    // -------------------------------------------------------------------------

    /**
     * The assembled filter tree.
     *
     * @returns the current filter tree (empty object when no filters have been
     * set)
     */
    filterTree(): Readonly<FilterTree> {
        return this.#state.filters;
    }

    /**
     * Emit the query as a flat `QueryParameters` record suitable for passing to
     * an `HttpClient` method.
     *
     * Only parameters with content are included; keys with no data are omitted.
     * Bracket-notation keys (e.g. `fields[users]`) are emitted as flat string
     * keys in the record.
     *
     * @returns the flat query-parameter record
     */
    toQueryParameters(): QueryParameters {
        return this.#buildParams();
    }

    /**
     * Emit the query as a URL-encoded query string.
     *
     * Keys and values are encoded by `URLSearchParams`. Bracket keys (e.g.
     * `fields[users]`) and JSON filter strings survive the round-trip intact:
     * parse back with `new URLSearchParams(string)` and the values will match
     * those in {@link toQueryParameters}.
     *
     * Key order follows insertion order, which is stable across identical query
     * builds.
     *
     * @returns the URL-encoded query string (without a leading `?`)
     */
    toQueryString(): string {
        const params = this.#buildParams();
        const search = new URLSearchParams();

        for (const [key, value] of Object.entries(params)) {
            search.set(key, String(value));
        }

        return search.toString();
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Assemble the flat parameter record from the current state.
     *
     * This is the single source-of-truth for parameter serialisation, shared by
     * both {@link toQueryParameters} and {@link toQueryString}.
     *
     * @returns the flat query-parameter record with no undefined entries
     */
    #buildParams(): Record<string, string | number | boolean> {
        const params: Record<string, string | number | boolean> = {};

        this.#applyFilterParam(params);
        this.#applyOrderParam(params);
        this.#applyPaginationParams(params);
        this.#applyShapingParams(params);

        return params;
    }

    /**
     * Write the `filters` parameter when the filter tree is non-empty.
     *
     * @param params - the parameter record to mutate
     */
    #applyFilterParam(params: Record<string, string | number | boolean>): void {
        if (Object.keys(this.#state.filters).length > 0) {
            params['filters'] = JSON.stringify(this.#state.filters);
        }
    }

    /**
     * Write the `order` parameter when the order list is non-empty.
     *
     * @param params - the parameter record to mutate
     */
    #applyOrderParam(params: Record<string, string | number | boolean>): void {
        if (this.#state.order.length > 0) {
            params['order'] = this.#state.order
                .map(e => (e.direction === 'asc' ? e.column : `${e.column}:desc`))
                .join(',');
        }
    }

    /**
     * Write pagination parameters (page, limit, cursor, pagination mode).
     *
     * @param params - the parameter record to mutate
     */
    #applyPaginationParams(params: Record<string, string | number | boolean>): void {
        if (this.#state.pageNumber !== undefined) {
            params['page'] = this.#state.pageNumber;
        }

        if (this.#state.limitNumber !== undefined) {
            params['limit'] = this.#state.limitNumber;
        }

        if (this.#state.cursorToken !== undefined) {
            params['cursor'] = this.#state.cursorToken;
        }

        if (this.#state.cursorPagination) {
            params['pagination'] = 'cursor';
        }
    }

    /**
     * Write sparse-fields, counts, sums, and averages parameters.
     *
     * @param params - the parameter record to mutate
     */
    #applyShapingParams(params: Record<string, string | number | boolean>): void {
        if (this.#state.fieldsList !== undefined) {
            params['fields'] = this.#state.fieldsList.join(',');
        }

        for (const [resource, names] of Object.entries(this.#state.fieldsMap)) {
            params[`fields[${resource}]`] = names.join(',');
        }

        if (this.#state.countsList !== undefined) {
            params['counts'] = this.#state.countsList.join(',');
        }

        for (const [resource, relations] of Object.entries(this.#state.countsMap)) {
            params[`counts[${resource}]`] = relations.join(',');
        }

        for (const [resource, relations] of Object.entries(this.#state.sumsMap)) {
            for (const [relation, fieldNames] of Object.entries(relations)) {
                params[`sums[${resource}][${relation}]`] = fieldNames.join(',');
            }
        }

        for (const [resource, relations] of Object.entries(this.#state.averagesMap)) {
            for (const [relation, fieldNames] of Object.entries(relations)) {
                params[`averages[${resource}][${relation}]`] = fieldNames.join(',');
            }
        }
    }

    /**
     * Return a new `ApiQuery` with `value` stored under `field` in the filter
     * tree.
     *
     * @param field - the filter tree key
     * @param value - the value to store
     * @returns a new `ApiQuery` with the updated filter tree
     */
    #withFilter(field: string, value: unknown): ApiQuery {
        return new ApiQuery({ ...this.#state, filters: { ...this.#state.filters, [field]: value } });
    }

    /**
     * Apply a `$has` or `$hasnt` condition.
     *
     * Bare relations (no build callback) are tracked separately so that when
     * the first conditioned relation is added, all bare relations are promoted
     * to the object form with `{}` entries. Once the object form is in use,
     * subsequent bare additions also use `{}`.
     *
     * @param key - either `'$has'` or `'$hasnt'`
     * @param relation - the relation name
     * @param build - optional sub-query builder
     * @returns a new `ApiQuery` with the existence condition applied
     */
    #applyHas(key: '$has' | '$hasnt', relation: string, build?: (query: ApiQuery) => ApiQuery): ApiQuery {
        const existing = this.#state.filters[key];
        const conditionTree = build ? build(ApiQuery.create()).#state.filters : undefined;

        // If the existing value is already an object (named form), stay in that
        // form. Bare additions use {} as their condition entry; conditioned
        // additions use their tree.
        if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
            const entry: FilterTree = conditionTree ?? {};
            const merged = { ...(existing as FilterTree), [relation]: entry };

            return this.#withFilter(key, merged);
        }

        // No existing entry: bare relation starts the array form.
        if (conditionTree === undefined) {
            const appended = Array.isArray(existing) ? [...(existing as string[]), relation] : [relation];

            return this.#withFilter(key, appended);
        }

        // Conditioned relation arriving: promote existing bare array (if any)
        // to object form. Each previously bare relation becomes a {} entry; the
        // new relation gets its tree.
        const baseEntries: Array<[string, FilterTree]> = Array.isArray(existing)
            ? (existing as string[]).map(r => [r, {}])
            : [];
        const objectForm = Object.fromEntries([...baseEntries, [relation, conditionTree]]);

        return this.#withFilter(key, objectForm);
    }
}
