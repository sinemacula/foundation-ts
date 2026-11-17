/**
 * Generic typed HTTP resource client over the laravel-api-toolkit envelope.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { HttpClient, HttpRequestOptions, QueryParameters } from '../http/http-client';
import type { ApiQuery } from './api-query';
import type { ListResult, ResourceMapper } from './envelope';
import { unwrapItem, unwrapList } from './envelope';
import { QueryError } from './query-error';

/** The id segments that would address the collection or a parent path. */
const INVALID_SEGMENTS: readonly string[] = ['', '.', '..'];

/** Construction options for {@link ResourceClient}. */
export interface ResourceClientOptions<Value> {
    /** The HTTP client used to issue requests. */
    readonly client: HttpClient;

    /** The resource collection path. */
    readonly path: string;

    /** Validates and maps each wire record onto the domain value. */
    readonly map: ResourceMapper<Value>;
}

/**
 * A typed CRUD client for a single API resource, built on {@link HttpClient}
 * and the laravel-api-toolkit response envelope.
 *
 * Ids are raw values: each `/`-separated segment is percent-encoded, and an id
 * with an empty, `.` or `..` segment rejects with a {@link QueryError} before
 * any request is sent.
 */
export class ResourceClient<Value> {
    /** The HTTP client used to issue requests. */
    readonly #client: HttpClient;

    /** The resource collection path. */
    readonly #path: string;

    /** Validates and maps each wire record onto the domain value. */
    readonly #map: ResourceMapper<Value>;

    /**
     * Construct a client bound to one API resource collection.
     */
    constructor(options: ResourceClientOptions<Value>) {
        this.#client = options.client;
        this.#path = options.path;
        this.#map = options.map;
    }

    /**
     * Fetch a page of the resource collection.
     *
     * @param query - merged into the request's query parameters
     * @param options - `options.query` entries win over `query` on collision
     * @throws {@link QueryError} when the response does not match the expected
     * envelope shape
     */
    async list(query?: ApiQuery, options?: HttpRequestOptions): Promise<ListResult<Value>> {
        const raw = await this.#client.get<unknown>(this.#path, buildRequestOptions(query, options));

        return unwrapList(raw, this.#map);
    }

    /**
     * Fetch a single resource by id.
     *
     * @param query - merged into the request's query parameters
     * @param options - `options.query` entries win over `query` on collision
     * @throws {@link QueryError} when the response does not match the expected
     * envelope shape
     */
    async show(id: string, query?: ApiQuery, options?: HttpRequestOptions): Promise<Value> {
        const raw = await this.#client.get<unknown>(resourcePath(this.#path, id), buildRequestOptions(query, options));

        return unwrapItem(raw, this.#map);
    }

    /**
     * Create a new resource.
     *
     * @param query - shapes the returned record, merged into the request's
     * query parameters
     * @param options - `options.query` entries win over `query` on collision
     * @throws {@link QueryError} when the response body is missing or does not
     * match the expected envelope shape
     */
    async create(
        body: Readonly<Record<string, unknown>>,
        query?: ApiQuery,
        options?: HttpRequestOptions,
    ): Promise<Value> {
        const raw = await this.#client.post<unknown>(this.#path, body, buildRequestOptions(query, options));

        return unwrapItem(raw, this.#map);
    }

    /**
     * Update an existing resource.
     *
     * @param query - shapes the returned record, merged into the request's
     * query parameters
     * @param options - `options.query` entries win over `query` on collision
     * @throws {@link QueryError} when the response body is missing or does not
     * match the expected envelope shape
     */
    async update(
        id: string,
        body: Readonly<Record<string, unknown>>,
        query?: ApiQuery,
        options?: HttpRequestOptions,
    ): Promise<Value> {
        const raw = await this.#client.patch<unknown>(
            resourcePath(this.#path, id),
            body,
            buildRequestOptions(query, options),
        );

        return unwrapItem(raw, this.#map);
    }

    /**
     * Apply an update whose endpoint answers with no content, such as a 204
     * action; any response body is ignored.
     */
    async updateWithoutContent(
        id: string,
        body: Readonly<Record<string, unknown>>,
        options?: HttpRequestOptions,
    ): Promise<void> {
        await this.#client.patch<void>(resourcePath(this.#path, id), body, options);
    }

    /**
     * Delete a resource by id.
     */
    async destroy(id: string, options?: HttpRequestOptions): Promise<void> {
        await this.#client.delete<void>(resourcePath(this.#path, id), options);
    }
}

/**
 * Join a resource path and an id without producing a double slash, encoding
 * each `/`-separated id segment.
 *
 * The trailing trim walks the string rather than using a `+`-then-anchor regex,
 * which backtracks polynomially on slash runs.
 *
 * @throws {@link QueryError} when an id segment is empty, `.` or `..`
 */
function resourcePath(path: string, id: string): string {
    const segments = id.replace(/^\/+/u, '').split('/');

    if (segments.some(segment => INVALID_SEGMENTS.includes(segment))) {
        throw new QueryError(`The resource id "${id}" is not a valid path.`);
    }

    let end = path.length;

    while (path[end - 1] === '/') {
        end -= 1;
    }

    return `${path.slice(0, end)}/${segments.map(encodeURIComponent).join('/')}`;
}

/**
 * Merge an {@link ApiQuery}'s parameters into request options, letting explicit
 * `options.query` entries win on key collision.
 *
 * @returns request options with the merged query record, or the original
 * options when there is nothing to merge
 */
function buildRequestOptions(
    query: ApiQuery | undefined,
    options: HttpRequestOptions | undefined,
): HttpRequestOptions | undefined {
    const mergedQuery = mergeQueryParameters(query, options?.query);

    if (mergedQuery === undefined) {
        return options;
    }

    return { ...options, query: mergedQuery };
}

/**
 * Merge query parameters from an `ApiQuery` with an explicit parameter record,
 * letting the explicit record win on key collision.
 *
 * @returns the merged record, or undefined when neither source is present
 */
function mergeQueryParameters(
    query: ApiQuery | undefined,
    explicit: QueryParameters | undefined,
): QueryParameters | undefined {
    if (query === undefined) {
        return explicit;
    }

    return { ...query.toQueryParameters(), ...explicit };
}
