/**
 * Generic typed HTTP resource client over the laravel-api-toolkit envelope.
 *
 * Module gateways instantiate one `ResourceClient` per resource, passing a
 * {@link ResourceMapper} that validates and maps the wire shape onto a domain
 * type. This kills per-module envelope/mapping re-implementation: list, show,
 * create, update, and destroy all share the same envelope-unwrapping and
 * query-merging logic.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { HttpClient, HttpRequestOptions, QueryParameters } from '../http/http-client';
import type { ApiQuery } from './api-query';
import type { ListResult, ResourceMapper } from './envelope';
import { unwrapItem, unwrapList } from './envelope';

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
     *
     * @param options - the HTTP client, resource path, and response mapper
     */
    constructor(options: ResourceClientOptions<Value>) {
        this.#client = options.client;
        this.#path = options.path;
        this.#map = options.map;
    }

    /**
     * Fetch a page of the resource collection.
     *
     * @param query - an optional {@link ApiQuery} merged into the request's
     * query parameters
     * @param options - optional request options; `options.query` entries win
     * over `query` on collision
     * @returns the mapped items and pagination metadata
     * @throws Error when the response does not match the expected envelope
     * shape
     */
    async list(query?: ApiQuery, options?: HttpRequestOptions): Promise<ListResult<Value>> {
        const raw = await this.#client.get<unknown>(this.#path, buildRequestOptions(query, options));

        return unwrapList(raw, this.#map);
    }

    /**
     * Fetch a single resource by id.
     *
     * @param id - the resource identifier
     * @param query - an optional {@link ApiQuery} merged into the request's
     * query parameters
     * @param options - optional request options; `options.query` entries win
     * over `query` on collision
     * @returns the mapped resource
     * @throws Error when the response does not match the expected envelope
     * shape
     */
    async show(id: string, query?: ApiQuery, options?: HttpRequestOptions): Promise<Value> {
        const raw = await this.#client.get<unknown>(joinPath(this.#path, id), buildRequestOptions(query, options));

        return unwrapItem(raw, this.#map);
    }

    /**
     * Create a new resource.
     *
     * @param body - the request body
     * @param options - optional request options
     * @returns the mapped created resource
     * @throws Error when the response does not match the expected envelope
     * shape
     */
    async create(body: Readonly<Record<string, unknown>>, options?: HttpRequestOptions): Promise<Value> {
        const raw = await this.#client.post<unknown>(this.#path, body, options);

        return unwrapItem(raw, this.#map);
    }

    /**
     * Update an existing resource.
     *
     * @param id - the resource identifier
     * @param body - the request body
     * @param options - optional request options
     * @returns the mapped updated resource
     * @throws Error when the response does not match the expected envelope
     * shape
     */
    async update(id: string, body: Readonly<Record<string, unknown>>, options?: HttpRequestOptions): Promise<Value> {
        const raw = await this.#client.patch<unknown>(joinPath(this.#path, id), body, options);

        return unwrapItem(raw, this.#map);
    }

    /**
     * Delete a resource by id.
     *
     * @param id - the resource identifier
     * @param options - optional request options
     */
    async destroy(id: string, options?: HttpRequestOptions): Promise<void> {
        await this.#client.delete<void>(joinPath(this.#path, id), options);
    }
}

/**
 * Join a resource path and id without producing a double slash.
 *
 * @param path - the resource's base path
 * @param id - the resource identifier
 * @returns the joined path
 */
function joinPath(path: string, id: string): string {
    return `${path.replace(/\/+$/u, '')}/${id.replace(/^\/+/u, '')}`;
}

/**
 * Merge an {@link ApiQuery}'s parameters into request options, letting explicit
 * `options.query` entries win on key collision.
 *
 * @param query - an optional query builder
 * @param options - optional request options carrying an explicit query record
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
 * @param query - an optional query builder
 * @param explicit - an optional explicit query-parameter record
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
