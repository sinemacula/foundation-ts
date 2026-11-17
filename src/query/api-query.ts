/**
 * Immutable fluent query builder for the laravel-api-toolkit 2.x wire protocol.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { isRecord } from '../support/is-record';
import type { QueryParameters } from '../http/http-client';
import type {
    FilterDocumentBuilder,
    FilterOperators,
    FilterScalar,
    FilterTree,
    ScalarOperator,
    SortDirection,
} from './filter-expression';
import { QueryError } from './query-error';

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
    readonly direction: SortDirection;
}

/** The immutable state shared between derived `ApiQuery` instances. */
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

/** The operator keys of the filter grammar. */
const OPERATORS: ReadonlySet<string> = new Set<keyof FilterOperators>([
    '$eq',
    '$neq',
    '$gt',
    '$lt',
    '$ge',
    '$le',
    '$in',
    '$between',
    '$contains',
    '$null',
    '$notNull',
]);

/**
 * Deep-freeze a filter node, stopping at nodes already frozen so a derived
 * query only freezes the nodes it adds.
 */
function freezeTree(node: unknown): void {
    // Primitives report frozen, so the walk also stops at every leaf.
    if (Object.isFrozen(node)) {
        return;
    }

    for (const child of Object.values(node as object)) {
        freezeTree(child);
    }

    Object.freeze(node);
}

/**
 * Refuse a `$`-prefixed name, which the grammar reserves for groups and
 * operators.
 *
 * @throws {@link QueryError} when the name starts with `$`
 */
function assertName(name: string): void {
    if (name.startsWith('$')) {
        throw new QueryError(`"${name}" is not a field or relation name.`);
    }
}

/**
 * Refuse a non-finite number, which JSON would encode as null.
 *
 * @param operand - a scalar or a list of scalars
 * @throws {@link QueryError} when any number is NaN or infinite
 */
function assertFinite(field: string, operand: unknown): void {
    if ([operand].flat().some(value => typeof value === 'number' && !Number.isFinite(value))) {
        throw new QueryError(`The "${field}" filter needs finite numbers.`);
    }
}

/**
 * Check a page number or size is a positive integer.
 *
 * @throws {@link QueryError} when it is not a safe integer of at least 1
 */
function positiveInteger(label: 'page' | 'limit', n: number): number {
    if (!Number.isSafeInteger(n) || n < 1) {
        throw new QueryError(`The ${label} must be a positive integer.`);
    }

    return n;
}

/**
 * Determine whether a filter document carries no conditions.
 */
function isEmpty(document: FilterTree): boolean {
    return Object.keys(document).length === 0;
}

/**
 * Determine whether two operands are the same condition: equal scalars, or
 * lists of equal scalars in the same order.
 */
function isSameOperand(a: unknown, b: unknown): boolean {
    if (!Array.isArray(a) || !Array.isArray(b)) {
        return a === b;
    }

    return a.length === b.length && a.every((item, i) => item === b[i]);
}

/**
 * Determine whether a field condition is an operator map rather than a relation
 * document.
 */
function isOperatorMap(condition: FilterTree): boolean {
    return Object.keys(condition).some(key => OPERATORS.has(key));
}

/**
 * Merge two operator maps on one field, which is lossless as a map is already a
 * conjunction, unless an operator collides with a different operand.
 *
 * @returns the merged map, or undefined when an operator collides
 */
function mergeOperators(current: FilterTree, incoming: FilterTree): FilterTree | undefined {
    const collides = Object.entries(incoming).some(
        ([operator, operand]) => current[operator] !== undefined && !isSameOperand(current[operator], operand),
    );

    return collides ? undefined : { ...current, ...incoming };
}

/**
 * Merge a condition into the one a key already holds without widening or
 * dropping either.
 *
 * A repeated condition is kept once, operator maps merge, and relation
 * documents merge key by key.
 *
 * @returns the merged condition, or undefined when the incoming one must stand
 * apart
 */
function mergeCondition(current: unknown, incoming: unknown): unknown {
    if (isSameOperand(current, incoming)) {
        return current;
    }

    if (!isRecord(current) || !isRecord(incoming) || isOperatorMap(current) !== isOperatorMap(incoming)) {
        return undefined;
    }

    return isOperatorMap(current) ? mergeOperators(current, incoming) : mergeDocument(current, incoming);
}

/**
 * Read a `$has` or `$hasnt` value as relation entries, a bare relation carrying
 * an empty document.
 *
 * @param value - the list or map stored under the existence key, if any
 */
function existenceEntries(value: unknown): Array<[string, FilterTree]> {
    if (isRecord(value)) {
        return Object.entries(value) as Array<[string, FilterTree]>;
    }

    return ((value ?? []) as readonly string[]).map(relation => [relation, {}]);
}

/**
 * Determine whether an `$and` document only refuses relations a bare `$hasnt`
 * already refuses, as a separated conditioned `$hasnt` does.
 *
 * @param bare - the relations a bare `$hasnt` refuses
 * @returns true when the bare relations imply the document
 */
function refusedOutright(document: FilterTree, bare: readonly string[]): boolean {
    const entries = existenceEntries(document['$hasnt']);

    return (
        Object.keys(document).length === 1 &&
        entries.length > 0 &&
        entries.every(([relation]) => bare.includes(relation))
    );
}

/**
 * Merge an existence value into the one a document already holds.
 *
 * `$has` documents on one relation merge, as every condition must hold for the
 * same related row. Under `$hasnt` a bare relation, which an empty document
 * also is, absorbs a conditioned one it already implies, and two conditioned
 * documents stay separate conditions: the later is returned to stand as its own
 * `$and` document. The list form survives while every relation is bare.
 *
 * @param existing - the value the document already holds under `key`
 * @param patch - the incoming list or map
 * @returns the merged value and the documents that must stand apart
 */
function mergeExistence(key: ExistenceKey, existing: unknown, patch: unknown): [unknown, FilterTree[]] {
    const merged = new Map(existenceEntries(existing));
    const apart: FilterTree[] = [];

    for (const [relation, document] of existenceEntries(patch)) {
        const current = merged.get(relation);

        if (key === '$has') {
            merged.set(relation, mergeDocument(current ?? {}, document));
        } else if (current === undefined) {
            merged.set(relation, document);
        } else if (isEmpty(current) || isEmpty(document)) {
            merged.set(relation, {});
        } else {
            apart.push({ [key]: { [relation]: document } });
        }
    }

    const entries = [...merged];
    const value = entries.every(([, document]) => isEmpty(document))
        ? entries.map(([relation]) => relation)
        : Object.fromEntries(entries);

    return [value, apart];
}

/**
 * Merge a filter document into another, both applying to the same rows, without
 * widening or dropping any condition either holds.
 *
 * Fields and relation documents merge key by key, existence values merge per
 * relation, and `$and` lists concatenate. A condition that cannot merge into
 * the key it targets, such as a second `$or`, a second conditioned `$hasnt` on
 * a relation or a different value for a field, joins the `$and` list as its own
 * document. A bare `$hasnt` drops the `$and` documents it implies.
 */
function mergeDocument(existing: FilterTree, patch: FilterTree): FilterTree {
    // A map keeps names such as `__proto__` and `constructor` plain keys.
    const merged = new Map(Object.entries(existing));
    const apart: FilterTree[] = [];

    for (const [key, value] of Object.entries(patch)) {
        const current = merged.get(key);

        if (key === '$has' || key === '$hasnt') {
            const [existence, separate] = mergeExistence(key, current, value);

            merged.set(key, existence);
            apart.push(...separate);
        } else if (current === undefined) {
            merged.set(key, value);
        } else if (key === '$and') {
            merged.set(key, [...(current as readonly FilterTree[]), ...(value as readonly FilterTree[])]);
        } else {
            const condition = mergeCondition(current, value);

            if (condition === undefined) {
                apart.push({ [key]: value });
            } else {
                merged.set(key, condition);
            }
        }
    }

    settleAnd(merged, apart);

    return Object.fromEntries(merged);
}

/**
 * Drop the `$and` documents the document's bare `$hasnt` relations imply,
 * append the documents that must stand apart, and remove the list once it is
 * empty.
 *
 * @param merged - the merged document, updated in place
 */
function settleAnd(merged: Map<string, unknown>, apart: readonly FilterTree[]): void {
    const bare = existenceEntries(merged.get('$hasnt'))
        .filter(([, document]) => isEmpty(document))
        .map(([relation]) => relation);
    const and = [
        ...((merged.get('$and') ?? []) as readonly FilterTree[]).filter(document => !refusedOutright(document, bare)),
        ...apart,
    ];

    if (and.length > 0) {
        merged.set('$and', and);
    } else {
        merged.delete('$and');
    }
}

/**
 * Immutable fluent query builder for the laravel-api-toolkit 2.x API.
 *
 * Construct via {@link ApiQuery.create}; every method returns a new instance,
 * so a base query is safe to share between derived queries. Filter calls AND
 * together: none replaces or widens a condition an earlier call added. A
 * {@link QueryError} is thrown for a field or relation name starting with `$`
 * and for a non-finite number.
 *
 * The toolkit gates every filter operator by the column's declared capability
 * (`exact`, `enum`, `range`, `document`, `opaque`): `$neq` only on an enum, the
 * ordering operators and `$between` only on a range, `$contains` only on a
 * document. Anything else is refused with a 422 keyed `filters.<path>.<op>`.
 */
// eslint-disable-next-line @sinemacula/max-methods-per-class -- fluent API
export class ApiQuery {
    /** The immutable state shared between derived instances. */
    readonly #state: QueryState;

    private constructor(state: QueryState) {
        freezeTree(state.filters);
        this.#state = state;
    }

    /**
     * Create a new, empty `ApiQuery`.
     */
    static create(): ApiQuery {
        return new ApiQuery(EMPTY_STATE);
    }

    /**
     * Add an equality filter on `field`.
     *
     * Every scalar is a real condition: `''`, `0` and `false` filter for that
     * value rather than clearing the filter.
     */
    where(field: string, value: FilterScalar): ApiQuery;

    /**
     * Add an operator filter on `field`.
     */
    where(field: string, operator: ScalarOperator, value: FilterScalar): ApiQuery;

    where(field: string, operatorOrValue: ScalarOperator | FilterScalar, value?: FilterScalar): ApiQuery {
        if (value === undefined) {
            return this.#withCondition(field, operatorOrValue, operatorOrValue);
        }

        return this.#withOperator(field, operatorOrValue as ScalarOperator, value);
    }

    /**
     * Add a `$in` filter: the field value must be one of `values`.
     */
    whereIn(field: string, values: readonly FilterScalar[]): ApiQuery {
        return this.#withOperator(field, '$in', values);
    }

    /**
     * Add a `$between` filter: the field value must lie within the inclusive
     * bounds.
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
     */
    whereContains(field: string, value: FilterScalar | readonly FilterScalar[]): ApiQuery {
        return this.#withOperator(field, '$contains', value);
    }

    /**
     * Add a `$null: true` filter: the field must be null.
     */
    whereNull(field: string): ApiQuery {
        return this.#withOperator(field, '$null', true);
    }

    /**
     * Add a `$notNull: true` filter: the field must not be null.
     */
    whereNotNull(field: string): ApiQuery {
        return this.#withOperator(field, '$notNull', true);
    }

    /**
     * Nest a sub-query's filter document under a relation key.
     *
     * ```ts
     * query.whereRelation('posts', q => q.where('published', true))
     * // -> { posts: { published: true } }
     * ```
     *
     * Repeated calls for the same relation merge into its one document, so
     * every condition must hold for the same related row. Logical groups are
     * never merged: a second `$or` on the relation is ANDed beside the first.
     */
    whereRelation(relation: string, build: FilterDocumentBuilder): ApiQuery {
        assertName(relation);

        return this.#withMergedDocument({ [relation]: ApiQuery.#document(build) });
    }

    /**
     * Assert that the relation exists, optionally matching the conditions
     * `build` adds.
     *
     * A bare relation joins the `$has` list, or the map as `{}` once any
     * relation is conditioned. Conditions asserted again on the same relation
     * merge into its document.
     */
    whereHas(relation: string, build?: FilterDocumentBuilder): ApiQuery {
        return this.#applyExistence('$has', relation, build);
    }

    /**
     * Assert that the relation does not exist, optionally matching the
     * conditions `build` adds.
     *
     * Same shape rules as {@link whereHas} under the `$hasnt` key, except that
     * conditions never merge: a bare assertion absorbs any conditioned one on
     * the relation, and a second conditioned one is ANDed beside the first.
     */
    whereHasNot(relation: string, build?: FilterDocumentBuilder): ApiQuery {
        return this.#applyExistence('$hasnt', relation, build);
    }

    /**
     * Add documents to the `$and` group.
     *
     * Each callback builds one document; the conditions inside a document AND
     * together and the documents AND with each other. Repeated calls append to
     * the same group.
     *
     * ```ts
     * query.andWhere([q => q.whereHas('posts', p => p.where('a', 1)), q => q.whereHas('posts', p => p.where('b', 2))])
     * // -> { "$and": [{ "$has": { "posts": { "a": 1 } } }, { "$has": { "posts": { "b": 2 } } }] }
     * ```
     *
     * @throws {@link QueryError} when no documents are given or a document has
     * no conditions
     */
    andWhere(documents: readonly FilterDocumentBuilder[]): ApiQuery {
        return this.#appendGroup('$and', documents);
    }

    /**
     * Add documents to the `$or` group.
     *
     * Each callback builds one document; the conditions inside a document AND
     * together and the documents OR with each other. A later call is ANDed
     * beside the earlier group rather than widening it.
     *
     * ```ts
     * query.orWhere([q => q.where('role', 'admin').where('status', 'active'), q => q.where('role', 'owner')])
     * // -> { "$or": [{ "role": "admin", "status": "active" }, { "role": "owner" }] }
     * ```
     *
     * @throws {@link QueryError} when no documents are given or a document has
     * no conditions
     */
    orWhere(documents: readonly FilterDocumentBuilder[]): ApiQuery {
        return this.#appendGroup('$or', documents);
    }

    /**
     * Match a free-text term against the fields the resource declares
     * searchable (`search=<term>`).
     *
     * The term is trimmed, and an empty or whitespace-only term clears the
     * search. By default the toolkit refuses a term with a word shorter than
     * three characters, over 128 characters, or over 10 words.
     */
    search(term: string): ApiQuery {
        const trimmed = term.trim();

        return this.#withRows({ searchTerm: trimmed === '' ? undefined : trimmed });
    }

    /**
     * Append a sort entry for `column`, moving it to the end of the order list
     * if it is already there.
     *
     * Any cursor token is dropped, as it only seeks within the order it was
     * issued for, but a cursor-paginated query stays cursor-paginated.
     *
     * @throws {@link QueryError} when random order meets cursor pagination
     */
    orderBy(column: string, direction: SortDirection = 'asc'): ApiQuery {
        return this.#withRows({
            order: [...this.#state.order.filter(e => e.column !== column), { column, direction }],
        });
    }

    /**
     * Request random ordering from the server.
     *
     * @throws {@link QueryError} when cursor pagination is in use
     */
    orderByRandom(): ApiQuery {
        return this.orderBy(RANDOM_ORDER);
    }

    /**
     * Set the 1-based page number.
     *
     * @throws {@link QueryError} when `n` is not a positive integer
     */
    page(n: number): ApiQuery {
        return new ApiQuery({ ...this.#state, pageNumber: positiveInteger('page', n) });
    }

    /**
     * Set the page size. The toolkit refuses a size over its ceiling (100 by
     * default) rather than clamping it.
     *
     * @throws {@link QueryError} when `n` is not a positive integer
     */
    limit(n: number): ApiQuery {
        return new ApiQuery({ ...this.#state, limitNumber: positiveInteger('limit', n) });
    }

    /**
     * Set the cursor token, which alone selects cursor pagination on the
     * server.
     *
     * A token seeks within one ordered row set, so any later filter, search,
     * soft-delete or order call drops it, even one repeating the current value,
     * while the query stays cursor-paginated. `limit` and `page` keep it.
     *
     * @param token - the opaque cursor string returned by the server
     * @throws {@link QueryError} when the order is random
     */
    cursor(token: string): ApiQuery {
        return ApiQuery.#guarded({ ...this.#state, cursorToken: token });
    }

    /**
     * Force cursor pagination (`pagination=cursor`).
     *
     * @throws {@link QueryError} when the order is random
     */
    useCursorPagination(): ApiQuery {
        return ApiQuery.#guarded({ ...this.#state, cursorPagination: true });
    }

    /**
     * Request a per-resource field list (`fields[user]=name,email`).
     */
    fieldsFor(resource: string, names: readonly string[]): ApiQuery {
        const fieldsMap = { ...this.#state.fieldsMap, [resource]: [...names] };

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
     */
    aggregatesFor(resource: string, keys: readonly string[]): ApiQuery {
        const aggregatesMap = { ...this.#state.aggregatesMap, [resource]: [...keys] };

        return new ApiQuery({ ...this.#state, aggregatesMap });
    }

    /**
     * Include soft-deleted records alongside live ones (`trashed=with`).
     */
    withTrashed(): ApiQuery {
        return this.#withRows({ trashed: 'with' });
    }

    /**
     * Read soft-deleted records only (`trashed=only`).
     */
    onlyTrashed(): ApiQuery {
        return this.#withRows({ trashed: 'only' });
    }

    /**
     * Return the assembled filter tree, deep-frozen, empty when no filters are
     * set.
     */
    filterTree(): Readonly<FilterTree> {
        return this.#state.filters;
    }

    /**
     * Emit the query as a flat `QueryParameters` record for an `HttpClient`
     * call, omitting empty parameters. Bracket keys such as `fields[user]` are
     * flat string keys.
     */
    toQueryParameters(): QueryParameters {
        return this.#buildParams();
    }

    /**
     * Emit the query as a `URLSearchParams`-encoded string, which parses back
     * to the values of {@link toQueryParameters} in a stable key order.
     *
     * @returns the query string, without a leading `?`
     */
    toQueryString(): string {
        const params = this.#buildParams();
        const search = new URLSearchParams();

        for (const [key, value] of Object.entries(params)) {
            // Some minimal URLSearchParams implementations ship append only.
            search.append(key, String(value));
        }

        return search.toString();
    }

    /**
     * Build one filter document on a fresh query.
     */
    static #document(build: FilterDocumentBuilder): FilterTree {
        return build(ApiQuery.create()).#state.filters;
    }

    /**
     * Build a query from `state`, refusing random order under cursor
     * pagination, which the toolkit cannot seek by.
     *
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
     */
    #applyFilterParams(params: Record<string, string | number | boolean>): void {
        if (!isEmpty(this.#state.filters)) {
            params['filters'] = JSON.stringify(this.#state.filters);
        }

        if (this.#state.searchTerm !== undefined) {
            params['search'] = this.#state.searchTerm;
        }
    }

    /**
     * Write the `order` parameter when the order list is non-empty.
     */
    #applyOrderParam(params: Record<string, string | number | boolean>): void {
        if (this.#state.order.length > 0) {
            params['order'] = this.#state.order
                .map(e => (e.direction === 'asc' ? e.column : `${e.column}:desc`))
                .join(',');
        }
    }

    /**
     * Write the page, limit, cursor and pagination-mode parameters.
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
     * Write the sparse-fields, aggregates and soft-delete visibility
     * parameters.
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
     * Return a query with `patch` applied, dropping any cursor token, which
     * only seeks within the row set and order it was issued for, while keeping
     * the query cursor-paginated.
     *
     * @throws {@link QueryError} when random order meets cursor pagination
     */
    #withRows(patch: Partial<QueryState>): ApiQuery {
        const { cursorToken, cursorPagination } = this.#state;

        return ApiQuery.#guarded({
            ...this.#state,
            ...patch,
            cursorToken: undefined,
            cursorPagination: cursorPagination || cursorToken !== undefined,
        });
    }

    /**
     * Return a query with one operator merged into `field`'s conditions,
     * copying a list operand so the caller keeps its array.
     */
    #withOperator(
        field: string,
        operator: keyof FilterOperators,
        operand: FilterScalar | readonly FilterScalar[] | true,
    ): ApiQuery {
        const value = Array.isArray(operand) ? [...operand] : operand;

        return this.#withCondition(field, { [operator]: value }, value);
    }

    /**
     * Return a query with `condition` merged into `field`.
     *
     * @param operand - the scalar or list the condition compares against
     */
    #withCondition(field: string, condition: unknown, operand: unknown): ApiQuery {
        assertName(field);
        assertFinite(field, operand);

        return this.#withMergedDocument({ [field]: condition });
    }

    /**
     * Return a query with `patch` merged into the root document.
     */
    #withMergedDocument(patch: FilterTree): ApiQuery {
        return this.#withRows({ filters: mergeDocument(this.#state.filters, patch) });
    }

    /**
     * Append one document per builder to a logical group.
     *
     * @throws {@link QueryError} when no builders are given or a document has
     * no conditions
     */
    #appendGroup(key: GroupKey, builders: readonly FilterDocumentBuilder[]): ApiQuery {
        if (builders.length === 0) {
            throw new QueryError(`A ${key} group needs at least one document.`);
        }

        const documents = builders.map(build => {
            const document = ApiQuery.#document(build);

            if (isEmpty(document)) {
                throw new QueryError(`Every ${key} document needs at least one condition.`);
            }

            return document;
        });

        return this.#withMergedDocument({ [key]: documents });
    }

    /**
     * Apply a `$has` or `$hasnt` condition.
     */
    #applyExistence(key: ExistenceKey, relation: string, build?: FilterDocumentBuilder): ApiQuery {
        assertName(relation);

        return this.#withMergedDocument({ [key]: build ? { [relation]: ApiQuery.#document(build) } : [relation] });
    }
}
