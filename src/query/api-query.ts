/**
 * Immutable fluent query builder for the laravel-api-toolkit 2.x wire protocol.
 *
 * `ApiQuery` is the organisation's structured-query surface over the API
 * toolkit - GraphQL-style shaping: filter, search, sort, paginate, sparse
 * fields, relation aggregates, and soft-delete visibility. Every method returns
 * a **new** `ApiQuery` instance; the original is never mutated, making it safe
 * to share a base query across multiple derived queries.
 *
 * ## Quick start
 * ```ts
 * const params = ApiQuery.create()
 *     .where('status', 'active')
 *     .where('age', '$ge', 18)
 *     .search('alice')
 *     .orderBy('name')
 *     .page(2)
 *     .limit(25)
 *     .fieldsFor('user', ['id', 'name', 'email'])
 *     .toQueryParameters();
 * ```
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { isRecord } from '../support/is-record';
import type { QueryParameters } from '../http/http-client';
import type { FilterOperators, FilterScalar, FilterTree } from './filter-expression';
import { QueryError } from './query-error';

/**
 * The scalar comparison operators accepted by the two-argument `where`
 * overload.
 */
type ScalarOperator = '$eq' | '$neq' | '$gt' | '$lt' | '$ge' | '$le';

/** Builds one filter document from a fresh query. */
type DocumentBuilder = (query: ApiQuery) => ApiQuery;

/** The logical group keys of the filter grammar. */
type GroupKey = '$and' | '$or';

/** The relation existence keys of the filter grammar. */
type ExistenceKey = '$has' | '$hasnt';

/** The soft-delete visibility values the toolkit accepts. */
type TrashedState = 'with' | 'only';

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

    /** The free-text search term, or undefined when unset. */
    readonly searchTerm: string | undefined;

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

    /** Per-resource sparse-field lists keyed by resource type. */
    readonly fieldsMap: Readonly<Record<string, readonly string[]>>;

    /** Per-resource aggregate keys keyed by resource type. */
    readonly aggregatesMap: Readonly<Record<string, readonly string[]>>;

    /** The soft-delete visibility, or undefined for live records only. */
    readonly trashed: TrashedState | undefined;
}

/** The empty initial state. */
const EMPTY_STATE: QueryState = {
    filters: {},
    searchTerm: undefined,
    order: [],
    pageNumber: undefined,
    limitNumber: undefined,
    cursorToken: undefined,
    cursorPagination: false,
    fieldsMap: {},
    aggregatesMap: {},
    trashed: undefined,
};

/** The order keyword the toolkit reads as random ordering. */
const RANDOM_ORDER = 'random';

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
    if (isRecord(existing)) {
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
 * Read a filter value as a list, treating anything else as empty.
 *
 * @param value - the value stored under a list-valued key
 * @returns the value when it is a list, otherwise an empty list
 */
function asList(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : [];
}

/**
 * Read a `$has` or `$hasnt` value as relation entries, a bare relation carrying
 * no document.
 *
 * @param value - the list or map stored under the existence key
 * @returns the relation names paired with their documents
 */
function existenceEntries(value: unknown): Array<[string, FilterTree | undefined]> {
    if (isRecord(value)) {
        return Object.entries(value) as Array<[string, FilterTree]>;
    }

    return asList(value).map(relation => [relation as string, undefined]);
}

/**
 * Merge two `$has` or `$hasnt` values.
 *
 * Documents asserted on the same relation merge, as every condition must hold
 * for the same related row. The list form survives while every relation is
 * bare; one conditioned relation promotes the rest to `{}` entries.
 *
 * @param existing - the current value stored under the existence key
 * @param patch - the incoming list or map
 * @returns the merged list or map
 */
function mergeExistence(existing: unknown, patch: unknown): unknown {
    const merged = new Map(existenceEntries(existing));

    for (const [relation, document] of existenceEntries(patch)) {
        const current = merged.get(relation);

        merged.set(relation, document === undefined ? current : mergeDocument(current ?? {}, document));
    }

    const entries = [...merged];

    if (entries.every(([, document]) => document === undefined)) {
        return entries.map(([relation]) => relation);
    }

    return Object.fromEntries(entries.map(([relation, document]) => [relation, document ?? {}]));
}

/**
 * Merge a filter document into another, both applying to the same rows.
 *
 * Fields and relation documents merge key by key, existence maps merge per
 * relation, and `$and` lists concatenate. Group documents never merge into each
 * other: a second `$or` joins the `$and` list as its own document so both
 * disjunctions keep their meaning. Any other collision is replaced.
 *
 * @param existing - the document already stored
 * @param patch - the document to merge in
 * @returns the merged document
 */
function mergeDocument(existing: FilterTree, patch: FilterTree): FilterTree {
    const merged: Record<string, unknown> = { ...existing };

    for (const [key, value] of Object.entries(patch)) {
        const current = merged[key];

        if (key === '$or' && Array.isArray(current)) {
            merged['$and'] = [...asList(merged['$and']), Object.fromEntries([[key, value]])];
        } else if (key === '$and') {
            merged[key] = [...asList(current), ...asList(value)];
        } else if (key === '$has' || key === '$hasnt') {
            merged[key] = mergeExistence(current, value);
        } else {
            merged[key] = isRecord(current) && isRecord(value) ? mergeDocument(current, value) : value;
        }
    }

    return merged;
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
 *
 * The toolkit gates every filter operator by the column's declared capability
 * (`exact`, `enum`, `range`, `document`, `opaque`): `$neq` only on an enum, the
 * ordering operators and `$between` only on a range, `$contains` only on a
 * document. Anything else is refused with a 422 keyed `filters.<path>.<op>`.
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
     * Add an equality filter on `field`.
     *
     * Every scalar is a real condition: `''`, `0` and `false` filter for that
     * value rather than clearing the filter.
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

        return this.#withOperator(field, operatorOrValue as ScalarOperator, value);
    }

    /**
     * Add a `$in` filter: the field value must be one of `values`.
     *
     * @param field - the field name
     * @param values - the allowed scalar values
     * @returns a new `ApiQuery` with the filter applied
     */
    whereIn(field: string, values: readonly FilterScalar[]): ApiQuery {
        return this.#withOperator(field, '$in', values);
    }

    /**
     * Add a `$between` filter: the field value must be between the two bounds.
     *
     * @param field - the field name
     * @param pair - the inclusive lower and upper bounds
     * @returns a new `ApiQuery` with the filter applied
     */
    whereBetween(field: string, pair: readonly [FilterScalar, FilterScalar]): ApiQuery {
        return this.#withOperator(field, '$between', pair);
    }

    /**
     * Add a `$contains` filter on a JSON document column.
     *
     * An array must all be contained (all-of); a comma-separated string matches
     * when any one item is contained (any-of); any other scalar is a single
     * containment check.
     *
     * @param field - the field name
     * @param value - a scalar or array of scalars the field must contain
     * @returns a new `ApiQuery` with the filter applied
     */
    whereContains(field: string, value: FilterScalar | readonly FilterScalar[]): ApiQuery {
        return this.#withOperator(field, '$contains', value);
    }

    /**
     * Add a `$null: true` filter: the field must be null.
     *
     * @param field - the field name
     * @returns a new `ApiQuery` with the filter applied
     */
    whereNull(field: string): ApiQuery {
        return this.#withOperator(field, '$null', true);
    }

    /**
     * Add a `$notNull: true` filter: the field must not be null.
     *
     * @param field - the field name
     * @returns a new `ApiQuery` with the filter applied
     */
    whereNotNull(field: string): ApiQuery {
        return this.#withOperator(field, '$notNull', true);
    }

    // -------------------------------------------------------------------------
    // Relation filters
    // -------------------------------------------------------------------------

    /**
     * Nest a sub-query's filter document under a relation key.
     *
     * ```ts
     * query.whereRelation('posts', q => q.where('published', true))
     * // → { posts: { published: true } }
     * ```
     *
     * Repeated calls for the same relation merge into its one document, so
     * every condition must hold for the same related row. Logical groups are
     * never merged: a second `$or` on the relation is ANDed beside the first.
     *
     * @param relation - the relation name
     * @param build - callback that receives a fresh query and returns the built
     * query
     * @returns a new `ApiQuery` with the relation filter applied
     */
    whereRelation(relation: string, build: DocumentBuilder): ApiQuery {
        const document = build(ApiQuery.create()).#state.filters;

        return this.#withMergedDocument(Object.fromEntries([[relation, document]]));
    }

    /**
     * Assert that the relation exists, optionally with conditions.
     *
     * Bare form (no build): adds the relation to the `$has` list (or map with
     * `{}` when a conditioned `$has` entry already exists). Conditioned form:
     * adds the relation with its filter document to the `$has` map. Conditions
     * asserted again on the same relation merge into its document.
     *
     * @param relation - the relation name
     * @param build - optional callback to add filter conditions on the relation
     * @returns a new `ApiQuery` with the `$has` condition applied
     */
    whereHas(relation: string, build?: DocumentBuilder): ApiQuery {
        return this.#applyExistence('$has', relation, build);
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
    whereHasNot(relation: string, build?: DocumentBuilder): ApiQuery {
        return this.#applyExistence('$hasnt', relation, build);
    }

    // -------------------------------------------------------------------------
    // Logical groups
    // -------------------------------------------------------------------------

    /**
     * Add documents to the `$and` group.
     *
     * Each callback builds one document; the conditions inside a document AND
     * together and the documents AND with each other. Repeated calls append to
     * the same group.
     *
     * ```ts
     * query.andWhere([q => q.whereHas('posts', p => p.where('a', 1)), q => q.whereHas('posts', p => p.where('b', 2))])
     * // → { "$and": [{ "$has": { "posts": { "a": 1 } } }, { "$has": { "posts": { "b": 2 } } }] }
     * ```
     *
     * @param documents - one builder per document in the group
     * @returns a new `ApiQuery` with the documents appended to `$and`
     * @throws {@link QueryError} when no documents are given or a document has
     * no conditions
     */
    andWhere(documents: readonly DocumentBuilder[]): ApiQuery {
        return this.#appendGroup('$and', documents);
    }

    /**
     * Add documents to the `$or` group.
     *
     * Each callback builds one document; the conditions inside a document AND
     * together and the documents OR with each other. Repeated calls append to
     * the same group.
     *
     * ```ts
     * query.orWhere([q => q.where('role', 'admin').where('status', 'active'), q => q.where('role', 'owner')])
     * // → { "$or": [{ "role": "admin", "status": "active" }, { "role": "owner" }] }
     * ```
     *
     * @param documents - one builder per document in the group
     * @returns a new `ApiQuery` with the documents appended to `$or`
     * @throws {@link QueryError} when no documents are given or a document has
     * no conditions
     */
    orWhere(documents: readonly DocumentBuilder[]): ApiQuery {
        return this.#appendGroup('$or', documents);
    }

    // -------------------------------------------------------------------------
    // Search
    // -------------------------------------------------------------------------

    /**
     * Match a free-text term against the fields the resource declares
     * searchable (`search=<term>`).
     *
     * An empty or whitespace-only term clears the search. The toolkit refuses a
     * term with a word shorter than three characters, over 128 characters, or
     * over 10 words.
     *
     * @param term - the search term
     * @returns a new `ApiQuery` with the search term set or cleared
     */
    search(term: string): ApiQuery {
        const trimmed = term.trim();

        return new ApiQuery({ ...this.#state, searchTerm: trimmed === '' ? undefined : trimmed });
    }

    // -------------------------------------------------------------------------
    // Ordering
    // -------------------------------------------------------------------------

    /**
     * Append a sort entry for `column`.
     *
     * If `column` already appears in the order list its previous entry is
     * removed before the new entry is appended at the end. Any cursor is
     * cleared, as a cursor only seeks within the order it was issued for.
     *
     * @param column - the column name to sort by
     * @param direction - sort direction; defaults to `'asc'`
     * @returns a new `ApiQuery` with the order entry appended
     * @throws {@link QueryError} when random order meets cursor pagination
     */
    orderBy(column: string, direction: 'asc' | 'desc' = 'asc'): ApiQuery {
        const order = [...this.#state.order.filter(e => e.column !== column), { column, direction }];

        return ApiQuery.#guarded({ ...this.#state, order, cursorToken: undefined });
    }

    /**
     * Request random ordering from the server.
     *
     * @returns a new `ApiQuery` with `random` appended to the order list
     * @throws {@link QueryError} when cursor pagination is in use
     */
    orderByRandom(): ApiQuery {
        return this.orderBy(RANDOM_ORDER);
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
     * Set the page size (≥1). The toolkit refuses a size over its ceiling (100
     * by default) rather than clamping it.
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
     * A cursor alone selects cursor pagination on the server.
     *
     * @param token - the opaque cursor string returned by the server
     * @returns a new `ApiQuery` with the cursor set
     * @throws {@link QueryError} when the order is random
     */
    cursor(token: string): ApiQuery {
        return ApiQuery.#guarded({ ...this.#state, cursorToken: token });
    }

    /**
     * Force cursor pagination by adding `pagination=cursor` to the parameters.
     *
     * @returns a new `ApiQuery` with cursor pagination enabled
     * @throws {@link QueryError} when the order is random
     */
    useCursorPagination(): ApiQuery {
        return ApiQuery.#guarded({ ...this.#state, cursorPagination: true });
    }

    // -------------------------------------------------------------------------
    // Sparse fields and aggregates
    // -------------------------------------------------------------------------

    /**
     * Request a per-resource field list (`fields[user]=name,email`).
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
     * Request declared relation aggregates for a resource type
     * (`aggregates[user]=posts_count,orders_sum_total`).
     *
     * Keys are the resource's declared aggregate keys: `{relation}_count`,
     * `{relation}_exists`, `{relation}_sum_{column}`,
     * `{relation}_avg_{column}`, `{relation}_min_{column}`,
     * `{relation}_max_{column}`, or a declared alias. Requesting any key
     * replaces the type's default aggregates. The values render under the
     * record's `aggregates` field only when `aggregates` is in `fields[type]`
     * or the resource's default fields.
     *
     * @param resource - the resource type name
     * @param keys - the aggregate keys to include
     * @returns a new `ApiQuery` with the per-resource aggregates set
     */
    aggregatesFor(resource: string, keys: readonly string[]): ApiQuery {
        const aggregatesMap = { ...this.#state.aggregatesMap, [resource]: keys };

        return new ApiQuery({ ...this.#state, aggregatesMap });
    }

    // -------------------------------------------------------------------------
    // Soft deletes
    // -------------------------------------------------------------------------

    /**
     * Include soft-deleted records alongside live ones (`trashed=with`).
     *
     * @returns a new `ApiQuery` reading live and trashed records
     */
    withTrashed(): ApiQuery {
        return new ApiQuery({ ...this.#state, trashed: 'with' });
    }

    /**
     * Read soft-deleted records only (`trashed=only`).
     *
     * @returns a new `ApiQuery` reading trashed records only
     */
    onlyTrashed(): ApiQuery {
        return new ApiQuery({ ...this.#state, trashed: 'only' });
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
     * Bracket-notation keys (e.g. `fields[user]`) are emitted as flat string
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
     * `fields[user]`) and JSON filter strings survive the round-trip intact:
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
            // append, not set: keys are unique by construction, and some
            // minimal URLSearchParams implementations ship append only.
            search.append(key, String(value));
        }

        return search.toString();
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Build a query from `state`, refusing random order under cursor
     * pagination, which the toolkit cannot seek by.
     *
     * @param state - the candidate state
     * @returns a new `ApiQuery` over `state`
     * @throws {@link QueryError} when random order meets cursor pagination
     */
    static #guarded(state: QueryState): ApiQuery {
        const cursorPaginated = state.cursorPagination || state.cursorToken !== undefined;

        if (cursorPaginated && state.order.some(e => e.column === RANDOM_ORDER)) {
            throw new QueryError('Random order cannot be combined with cursor pagination.');
        }

        return new ApiQuery(state);
    }

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

        this.#applyFilterParams(params);
        this.#applyOrderParam(params);
        this.#applyPaginationParams(params);
        this.#applyShapingParams(params);

        return params;
    }

    /**
     * Write the `filters` parameter when the filter tree is non-empty, and the
     * `search` parameter when a term is set.
     *
     * @param params - the parameter record to mutate
     */
    #applyFilterParams(params: Record<string, string | number | boolean>): void {
        if (Object.keys(this.#state.filters).length > 0) {
            params['filters'] = JSON.stringify(this.#state.filters);
        }

        if (this.#state.searchTerm !== undefined) {
            params['search'] = this.#state.searchTerm;
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
     * Write sparse-fields, aggregates, and soft-delete visibility parameters.
     *
     * @param params - the parameter record to mutate
     */
    #applyShapingParams(params: Record<string, string | number | boolean>): void {
        for (const [resource, names] of Object.entries(this.#state.fieldsMap)) {
            params[`fields[${resource}]`] = names.join(',');
        }

        for (const [resource, keys] of Object.entries(this.#state.aggregatesMap)) {
            params[`aggregates[${resource}]`] = keys.join(',');
        }

        if (this.#state.trashed !== undefined) {
            params['trashed'] = this.#state.trashed;
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
     * Return a new `ApiQuery` with one operator merged into `field`'s operator
     * map.
     *
     * @param field - the field name
     * @param operator - the wire-protocol operator
     * @param value - the operand stored under the operator
     * @returns a new `ApiQuery` with the operator applied
     */
    #withOperator(field: string, operator: string, value: unknown): ApiQuery {
        return this.#withFilter(field, mergeOperators(this.#state.filters[field], operatorPatch(operator, value)));
    }

    /**
     * Return a new `ApiQuery` with `patch` merged into the root document.
     *
     * @param patch - the document to merge in
     * @returns a new `ApiQuery` with the merged filter tree
     */
    #withMergedDocument(patch: FilterTree): ApiQuery {
        return new ApiQuery({ ...this.#state, filters: mergeDocument(this.#state.filters, patch) });
    }

    /**
     * Append one document per builder to a logical group.
     *
     * @param key - either `'$and'` or `'$or'`
     * @param builders - one builder per document
     * @returns a new `ApiQuery` with the documents appended to the group
     * @throws {@link QueryError} when no builders are given or a document has
     * no conditions
     */
    #appendGroup(key: GroupKey, builders: readonly DocumentBuilder[]): ApiQuery {
        if (builders.length === 0) {
            throw new QueryError(`A ${key} group needs at least one document.`);
        }

        const documents = builders.map(build => {
            const document = build(ApiQuery.create()).#state.filters;

            if (Object.keys(document).length === 0) {
                throw new QueryError(`Every ${key} document needs at least one condition.`);
            }

            return document;
        });

        return this.#withFilter(key, [...asList(this.#state.filters[key]), ...documents]);
    }

    /**
     * Apply a `$has` or `$hasnt` condition.
     *
     * @param key - either `'$has'` or `'$hasnt'`
     * @param relation - the relation name
     * @param build - optional sub-query builder
     * @returns a new `ApiQuery` with the existence condition applied
     */
    #applyExistence(key: ExistenceKey, relation: string, build?: DocumentBuilder): ApiQuery {
        const patch = build ? Object.fromEntries([[relation, build(ApiQuery.create()).#state.filters]]) : [relation];

        return this.#withFilter(key, mergeExistence(this.#state.filters[key], patch));
    }
}
