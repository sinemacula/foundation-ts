/**
 * Decoding of non-success response bodies onto the {@link HttpError} hierarchy.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { isRecord } from '../support/is-record';
import { ApiErrorCode, HttpError, HttpValidationError, MaintenanceError, QueryTooExpensiveError } from './http-error';
import type { HttpErrorDetails, QueryTooExpensiveMeta } from './http-error';

/** The query-cost meta fields carried as strings. */
const QUERY_COST_STRING_FIELDS = ['parameter', 'pointer', 'reason'] as const;

/** The query-cost meta fields carried as numbers. */
const QUERY_COST_NUMBER_FIELDS = ['limit', 'actual'] as const;

/**
 * Map a non-success response onto the error hierarchy, reading the API error
 * envelope (`{error: {status, code, title, detail, meta}}`) when present and
 * the plain `{message, errors}` shape otherwise.
 */
export function toResponseError(status: number, text: string): HttpError {
    const payload = parseJsonOrNull(text);
    const envelope = isRecord(payload) ? payload['error'] : null;

    if (isRecord(envelope) && typeof envelope['code'] === 'number') {
        return toEnvelopeError(status, payload, envelope, envelope['code']);
    }

    return toPlainError(status, payload);
}

/**
 * Map an API error envelope onto the error hierarchy, narrowing the codes
 * callers branch on.
 *
 * @param payload - the whole parsed body
 * @param envelope - the body's `error` object
 */
function toEnvelopeError(status: number, payload: unknown, envelope: Record<string, unknown>, code: number): HttpError {
    const title = nonEmptyString(envelope['title']);
    const message = nonEmptyString(envelope['detail']) ?? title ?? statusMessage(status);
    const details: HttpErrorDetails = { code, title };
    const meta = envelope['meta'];

    if (code === ApiErrorCode.InvalidInput) {
        return new HttpValidationError(status, message, payload, toFieldErrors(meta) ?? {}, details);
    }

    if (code === ApiErrorCode.MaintenanceMode) {
        return new MaintenanceError(status, message, payload, details);
    }

    const cost = code === ApiErrorCode.QueryTooExpensive ? toQueryCostMeta(meta) : null;

    return cost === null
        ? new HttpError(status, message, payload, details)
        : new QueryTooExpensiveError(status, message, payload, cost, details);
}

/**
 * Map a plain `{message, errors}` error body, as sent by endpoints outside the
 * API error envelope, onto the error hierarchy.
 *
 * @param payload - the parsed body, or null when it is not JSON
 */
function toPlainError(status: number, payload: unknown): HttpError {
    const message = isRecord(payload) ? nonEmptyString(payload['message']) : null;
    const errors = isRecord(payload) ? toFieldErrors(payload['errors']) : null;

    if (status === 422 && errors !== null) {
        return new HttpValidationError(status, message ?? statusMessage(status), payload, errors);
    }

    return new HttpError(status, message ?? statusMessage(status), payload);
}

/**
 * Normalise a per-field error map, keeping only string messages.
 *
 * @returns the normalised map, or null when the value is not a record
 */
function toFieldErrors(value: unknown): Record<string, readonly string[]> | null {
    if (!isRecord(value)) {
        return null;
    }

    const errors: Record<string, readonly string[]> = {};

    for (const [field, messages] of Object.entries(value)) {
        if (Array.isArray(messages)) {
            errors[field] = messages.filter((message): message is string => typeof message === 'string');
        }
    }

    return errors;
}

/**
 * Read the cap details from a query-too-expensive envelope's `meta`.
 *
 * @returns the typed details, or null when any field is missing or mistyped
 */
function toQueryCostMeta(value: unknown): QueryTooExpensiveMeta | null {
    if (!isQueryCostMeta(value)) {
        return null;
    }

    const { parameter, pointer, reason, limit, actual } = value;

    return { parameter, pointer, reason, limit, actual };
}

/**
 * Determine whether a value carries every query-cost field with its type.
 */
function isQueryCostMeta(value: unknown): value is QueryTooExpensiveMeta {
    return (
        isRecord(value) &&
        QUERY_COST_STRING_FIELDS.every(field => typeof value[field] === 'string') &&
        QUERY_COST_NUMBER_FIELDS.every(field => typeof value[field] === 'number')
    );
}

/**
 * Best-effort parse of an error response body, or null when it is not JSON.
 */
function parseJsonOrNull(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * Narrow a value to a non-empty string, or null.
 */
function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Build the generic message for a status without a usable body message.
 */
function statusMessage(status: number): string {
    return `Request failed with status ${status}.`;
}
