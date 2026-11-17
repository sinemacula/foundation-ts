/**
 * Response-envelope unwrapping for the laravel-api-toolkit wire protocol.
 *
 * Every endpoint wraps its payload in a `{ data: ... }` envelope, with list
 * endpoints additionally carrying `meta` and `links` blocks for pagination.
 * This module is the single place that peels the envelope away and hands
 * callers a typed domain value (or list of values) via a caller-supplied
 * {@link ResourceMapper}.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { isRecord } from '../support/is-record';
import { QueryError } from './query-error';

/**
 * A raw wire-format record, prior to mapping onto a domain type.
 *
 * The toolkit's reserved keys are checked before the record reaches a mapper;
 * every other field is left for the mapper to validate.
 */
export interface RawRecord extends Readonly<Record<string, unknown>> {
    // biome-ignore-start lint/style/useNamingConvention: toolkit keys

    /** The resource type the record was rendered as. */
    readonly _type?: string;

    /** The to-many relation fields cut short at the per-parent cap. */
    readonly _truncated?: readonly string[];

    // biome-ignore-end lint/style/useNamingConvention: toolkit keys

    /** The requested relation aggregates, keyed by aggregate key. */
    readonly aggregates?: Readonly<Record<string, unknown>>;
}

/**
 * Validates and maps a single raw wire record onto a domain value.
 *
 * Implementations throw when the record does not match the expected shape.
 */
export type ResourceMapper<Value> = (raw: RawRecord) => Value;

/** Metadata of a length-aware (page-numbered) list. */
export interface LengthAwarePaginationMeta {
    /** Discriminates the pagination mode. */
    readonly mode: 'length-aware';

    /** The total number of items across all pages. */
    readonly total: number;

    /** The number of items on this page. */
    readonly count: number;

    /** Whether a further page exists. */
    readonly hasMore: boolean;
}

/** Metadata of a cursor-paginated list. */
export interface CursorPaginationMeta {
    /** Discriminates the pagination mode. */
    readonly mode: 'cursor';

    /** Whether a further page exists. */
    readonly hasMore: boolean;
}

/** List pagination metadata, mapped from the envelope's `meta` block. */
export type PaginationMeta = LengthAwarePaginationMeta | CursorPaginationMeta;

/**
 * The navigation links of a list envelope; a link the response omits or leaves
 * empty is null. Cursor lists carry no `first` or `last`.
 */
export interface PaginationLinks {
    /** The URL of this page. */
    readonly self: string | null;

    /** The URL of the first page. */
    readonly first: string | null;

    /** The URL of the previous page. */
    readonly prev: string | null;

    /** The URL of the next page. */
    readonly next: string | null;

    /** The URL of the last page. */
    readonly last: string | null;
}

/**
 * The result of unwrapping a list envelope: mapped items plus optional
 * pagination metadata and links.
 */
export interface ListResult<Value> {
    /** The mapped domain values for this page. */
    readonly items: readonly Value[];

    /** The pagination metadata, or null when absent or malformed. */
    readonly meta: PaginationMeta | null;

    /** The pagination links, or null when absent or malformed. */
    readonly links: PaginationLinks | null;

    /** The cursor of the next page, read from `links.next`, or null. */
    readonly nextCursor: string | null;

    /** The cursor of the previous page, read from `links.prev`, or null. */
    readonly prevCursor: string | null;
}

/** The message raised for any envelope that does not match the protocol. */
const MALFORMED_ENVELOPE = 'The response did not match the expected envelope shape.';

/** Captures a non-empty `cursor` query parameter ahead of any fragment. */
const CURSOR_PARAMETER = /^[^#]*?[?&]cursor=([^&#]+)/u;

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
    if (!isRecord(payload)) {
        throw new QueryError(MALFORMED_ENVELOPE);
    }

    return map(toRawRecord(payload['data']));
}

/**
 * Unwrap a `{ data: [...], meta?: {...}, links?: {...} }` list envelope and map
 * each entry onto a domain value.
 *
 * @param payload - the raw response payload
 * @param map - validates and maps each raw record onto the domain value
 * @returns the mapped items, pagination metadata and links (null when absent
 * or malformed), and the cursors parsed from the links
 * @throws {@link QueryError} when the envelope is absent or malformed
 */
export function unwrapList<Value>(payload: unknown, map: ResourceMapper<Value>): ListResult<Value> {
    if (!isRecord(payload) || !Array.isArray(payload['data'])) {
        throw new QueryError(MALFORMED_ENVELOPE);
    }

    const items = payload['data'].map(entry => map(toRawRecord(entry)));
    const links = mapPaginationLinks(payload['links']);

    return {
        items,
        meta: mapPaginationMeta(payload['meta']),
        links,
        nextCursor: readCursor(links?.next),
        prevCursor: readCursor(links?.prev),
    };
}

/**
 * Check a wire value is a record whose reserved toolkit keys are well formed.
 *
 * @param value - the wire value
 * @returns the value as a {@link RawRecord}
 * @throws {@link QueryError} when the value is not a record or a reserved key
 * has the wrong shape
 */
function toRawRecord(value: unknown): RawRecord {
    if (
        !isRecord(value) ||
        !isOptional(value['_type'], v => typeof v === 'string') ||
        !isOptional(value['_truncated'], isStringList) ||
        !isOptional(value['aggregates'], isRecord)
    ) {
        throw new QueryError(MALFORMED_ENVELOPE);
    }

    return value;
}

/**
 * Determine whether a value is absent or passes `check`.
 *
 * @param value - the value to inspect
 * @param check - the guard a present value must pass
 * @returns true when the value is undefined or passes the guard
 */
function isOptional(value: unknown, check: (v: unknown) => boolean): boolean {
    return value === undefined || check(value);
}

/**
 * Determine whether a value is a list of strings.
 *
 * @param value - the value to inspect
 * @returns true when every entry of the list is a string
 */
function isStringList(value: unknown): boolean {
    return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

/**
 * Map a raw `meta` block onto {@link PaginationMeta}.
 *
 * A block with numeric `total` and `count` is length-aware; one carrying
 * neither is a cursor list.
 *
 * @param raw - the raw `meta` value from the envelope
 * @returns the mapped pagination metadata, or null when the block is absent,
 * non-record, or malformed
 */
function mapPaginationMeta(raw: unknown): PaginationMeta | null {
    if (!isRecord(raw) || typeof raw['continue'] !== 'boolean') {
        return null;
    }

    const { total, count } = raw;
    const hasMore = raw['continue'];

    if (typeof total === 'number' && typeof count === 'number') {
        return { mode: 'length-aware', total, count, hasMore };
    }

    if (total === undefined && count === undefined) {
        return { mode: 'cursor', hasMore };
    }

    return null;
}

/**
 * Map a raw `links` block onto {@link PaginationLinks}.
 *
 * @param raw - the raw `links` value from the envelope
 * @returns the mapped links, or null when the block is absent or non-record
 */
function mapPaginationLinks(raw: unknown): PaginationLinks | null {
    if (!isRecord(raw)) {
        return null;
    }

    return {
        self: readLink(raw['self']),
        first: readLink(raw['first']),
        prev: readLink(raw['prev']),
        next: readLink(raw['next']),
        last: readLink(raw['last']),
    };
}

/**
 * Read one link, treating anything but a non-empty string as absent.
 *
 * @param value - the raw link value
 * @returns the link URL, or null
 */
function readLink(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read the `cursor` query parameter from a pagination link.
 *
 * Parsed by hand: a link may be relative, and some runtimes ship only a partial
 * `URL`.
 *
 * @param link - the link URL, or null
 * @returns the decoded cursor, or null when the link carries none
 */
function readCursor(link: string | null | undefined): string | null {
    const value = CURSOR_PARAMETER.exec(link ?? '')?.[1];

    return value === undefined ? null : decodeComponent(value);
}

/**
 * Decode one form-encoded query component.
 *
 * @param component - the raw component
 * @returns the decoded text
 * @throws {@link QueryError} when the component carries a malformed escape
 */
function decodeComponent(component: string): string {
    try {
        return decodeURIComponent(component.replaceAll('+', ' '));
    } catch (error) {
        throw new QueryError(MALFORMED_ENVELOPE, { cause: error });
    }
}
