/**
 * Response-envelope unwrapping for the laravel-api-toolkit wire protocol.
 *
 * Every endpoint wraps its payload in a `{ data: ... }` envelope, with list
 * endpoints additionally carrying a `meta` block for pagination. This module is
 * the single place that peels the envelope away and hands callers a typed
 * domain value (or list of values) via a caller-supplied
 * {@link ResourceMapper}.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { isRecord } from '../support/is-record';
import { QueryError } from './query-error';

/** A raw wire-format record, prior to mapping onto a domain type. */
export type RawRecord = Readonly<Record<string, unknown>>;

/**
 * Validates and maps a single raw wire record onto a domain value.
 *
 * Implementations throw when the record does not match the expected shape.
 */
export type ResourceMapper<Value> = (raw: RawRecord) => Value;

/**
 * Laravel paginator metadata, mapped from the envelope's snake_case wire keys.
 */
export interface PaginationMeta {
    /** The current page number. */
    readonly currentPage: number;

    /** The last available page number. */
    readonly lastPage: number;

    /** The number of items per page. */
    readonly perPage: number;

    /** The total number of items across all pages. */
    readonly total: number;
}

/**
 * The result of unwrapping a list envelope: mapped items plus optional
 * pagination metadata.
 */
export interface ListResult<Value> {
    /** The mapped domain values for this page. */
    readonly items: readonly Value[];

    /** The pagination metadata, or null when absent or malformed. */
    readonly meta: PaginationMeta | null;
}

/**
 * Unwrap a `{ data: {...} }` single-resource envelope and map it onto a domain
 * value.
 *
 * @param payload - the raw response payload
 * @param map - validates and maps the raw record onto the domain value
 * @returns the mapped domain value
 * @throws {@link QueryError} when the envelope is absent or malformed
 */
export function unwrapItem<Value>(payload: unknown, map: ResourceMapper<Value>): Value {
    if (!isRecord(payload) || !isRecord(payload['data'])) {
        throw new QueryError('The response did not match the expected envelope shape.');
    }

    return map(payload['data']);
}

/**
 * Unwrap a `{ data: [...], meta?: {...} }` list envelope and map each entry
 * onto a domain value.
 *
 * @param payload - the raw response payload
 * @param map - validates and maps each raw record onto the domain value
 * @returns the mapped items and pagination metadata (null when the `meta` block
 * is absent or malformed)
 * @throws {@link QueryError} when the envelope is absent or malformed
 */
export function unwrapList<Value>(payload: unknown, map: ResourceMapper<Value>): ListResult<Value> {
    if (!isRecord(payload) || !Array.isArray(payload['data'])) {
        throw new QueryError('The response did not match the expected envelope shape.');
    }

    const items = payload['data'].map(entry => {
        if (!isRecord(entry)) {
            throw new QueryError('The response did not match the expected envelope shape.');
        }

        return map(entry);
    });

    return { items, meta: mapPaginationMeta(payload['meta']) };
}

/**
 * Map a raw `meta` block onto {@link PaginationMeta}.
 *
 * @param raw - the raw `meta` value from the envelope
 * @returns the mapped pagination metadata, or null when the block is absent,
 * non-record, or carries a missing/non-numeric pagination key
 */
function mapPaginationMeta(raw: unknown): PaginationMeta | null {
    if (!isRecord(raw)) {
        return null;
    }

    const currentPage = raw['current_page'];
    const lastPage = raw['last_page'];
    const perPage = raw['per_page'];
    const total = raw['total'];

    if (
        typeof currentPage !== 'number' ||
        typeof lastPage !== 'number' ||
        typeof perPage !== 'number' ||
        typeof total !== 'number'
    ) {
        return null;
    }

    return { currentPage, lastPage, perPage, total };
}
