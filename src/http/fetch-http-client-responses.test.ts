/**
 * Unit tests for FetchHttpClient - response handling (success parsing, error
 * mapping, validation errors, and blob downloads).
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import { FetchHttpClient } from './fetch-http-client';
import { ApiErrorCode, HttpError, HttpValidationError, MaintenanceError, QueryTooExpensiveError } from './http-error';

/** A user body parsed from JSON. */
interface UserBody {
    /** The user identifier. */
    readonly id: number;

    /** The user name. */
    readonly name: string;
}

// ---------------------------------------------------------------------------
// Stub type
// ---------------------------------------------------------------------------

/** Explicit overload signature so mock.calls carries a typed tuple, not []. */
type FetchArgs = [input: Request | string | URL, init?: RequestInit];

/** A constructor of the error type a rejection is expected to have. */
type ErrorType<E extends Error> = new (...args: never[]) => E;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a JSON response.
 *
 * @param body - the value to serialise
 * @param status - the response status
 * @param extra - additional response headers
 * @returns the response
 */
function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...extra },
    });
}

/**
 * Build a plain-text response.
 *
 * @param body - the response text
 * @param status - the response status
 * @returns the response
 */
function textResponse(body: string, status = 200): Response {
    return new Response(body, {
        status,
        headers: { 'content-type': 'text/plain' },
    });
}

/**
 * Build a response without a body.
 *
 * @param status - the response status
 * @returns the response
 */
function emptyResponse(status = 204): Response {
    return new Response(null, { status });
}

/**
 * Build an HTML error response.
 *
 * @param status - the response status
 * @returns the response
 */
function nonJsonErrorResponse(status: number): Response {
    return new Response('<html>error</html>', {
        status,
        headers: { 'content-type': 'text/html' },
    });
}

/**
 * Wrap a fetch implementation in a typed stub.
 *
 * @param impl - the fetch implementation
 * @returns the stub
 */
function makeFetch(
    impl: (...args: FetchArgs) => Promise<Response>,
): ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>> {
    return vi.fn<(...args: FetchArgs) => Promise<Response>>(impl);
}

/**
 * Build a client against the stub with optional extra options.
 *
 * @param fetchFn - the fetch stub
 * @param extra - options to merge over the base URL and stub
 * @returns the client
 */
function makeClient(
    fetchFn: typeof fetch,
    extra: Partial<ConstructorParameters<typeof FetchHttpClient>[0]> = {},
): FetchHttpClient {
    return new FetchHttpClient({ baseUrl: 'https://api.example.com', fetchFn, ...extra });
}

/**
 * Await a request expected to reject with a given error type.
 *
 * @param promise - the pending request
 * @param type - the error type the rejection must have
 * @returns the rejection
 */
async function rejectionOf<E extends Error>(promise: Promise<unknown>, type: ErrorType<E>): Promise<E> {
    const error = await promise.catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(type);

    return error as E;
}

/**
 * Request a path from a server sending one response, and return the rejection.
 *
 * @param response - the response the server sends
 * @param type - the error type the rejection must have
 * @returns the rejection
 */
function rejectionFor<E extends Error>(response: Response, type: ErrorType<E>): Promise<E> {
    return rejectionOf(makeClient(makeFetch(async () => response)).get('/fail'), type);
}

// ---------------------------------------------------------------------------
// Successful response parsing
// ---------------------------------------------------------------------------

describe('FetchHttpClient - success response parsing', () => {
    it('returns undefined for an empty body', async () => {
        const fetchFn = makeFetch(async () => emptyResponse(204));
        const client = makeClient(fetchFn);

        const result = await client.delete('/items/1');

        expect(result).toBeUndefined();
    });

    it('parses a JSON response body', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ id: 1, name: 'Alice' }));
        const client = makeClient(fetchFn);

        const result = await client.get<UserBody>('/users/1');

        expect(result).toStrictEqual({ id: 1, name: 'Alice' });
    });

    it('returns the raw string for a text/plain response', async () => {
        const fetchFn = makeFetch(async () => textResponse('hello world'));
        const client = makeClient(fetchFn);

        const result = await client.get<string>('/ping');

        expect(result).toBe('hello world');
    });

    it('returns the raw string when the content-type header is absent (null from headers.get)', async () => {
        // A Blob with an empty MIME type produces a Response whose headers
        // carry no content-type, exercising the ?? fallback branch.
        const fetchFn = makeFetch(async () => new Response(new Blob(['raw body'], { type: '' }), { status: 200 }));
        const client = makeClient(fetchFn);

        const result = await client.get<string>('/ping');

        expect(result).toBe('raw body');
    });
});

// ---------------------------------------------------------------------------
// Non-ok response mapping
// ---------------------------------------------------------------------------

describe('FetchHttpClient - error response mapping', () => {
    it('uses the payload message when present', async () => {
        const error = await rejectionFor(jsonResponse({ message: 'custom error' }, 400), HttpError);

        expect(error.message).toBe('custom error');
    });

    it('uses a generic status message when payload has no message', async () => {
        const error = await rejectionFor(jsonResponse({ code: 'E001' }, 400), HttpError);

        expect(error.message).toBe('Request failed with status 400.');
    });

    it('uses a generic status message when payload is not a record', async () => {
        const error = await rejectionFor(jsonResponse('not a record', 400), HttpError);

        expect(error.message).toBe('Request failed with status 400.');
    });

    it('sets payload to null when error body is not JSON', async () => {
        const error = await rejectionFor(nonJsonErrorResponse(500), HttpError);

        expect(error.payload).toBeNull();
    });

    it('throws HttpValidationError for 422 with a valid errors record', async () => {
        const error = await rejectionFor(
            jsonResponse({ message: 'invalid', errors: { email: ['required'] } }, 422),
            HttpValidationError,
        );

        expect(error.errors).toStrictEqual({ email: ['required'] });
        expect(error.message).toBe('invalid');
        expect(error.code).toBeNull();
    });

    it('uses a generic status message for a 422 errors record without a message', async () => {
        const error = await rejectionFor(jsonResponse({ errors: { email: ['required'] } }, 422), HttpValidationError);

        expect(error.message).toBe('Request failed with status 422.');
    });

    it('filters non-string entries from validation error arrays', async () => {
        const error = await rejectionFor(
            jsonResponse({ errors: { field: ['valid', 42, null, 'also valid'] } }, 422),
            HttpValidationError,
        );

        expect(error.errors).toStrictEqual({ field: ['valid', 'also valid'] });
    });

    it('skips field values that are not arrays in a 422 errors record', async () => {
        const error = await rejectionFor(
            jsonResponse({ errors: { field: 'not an array', other: ['valid'] } }, 422),
            HttpValidationError,
        );

        expect(error.errors).toStrictEqual({ other: ['valid'] });
    });

    it.each([
        ['a 422 without an errors record', jsonResponse({ message: 'unprocessable' }, 422)],
        ['a non-422 response with an errors key', jsonResponse({ errors: { field: ['bad'] } }, 400)],
        ['a 422 whose errors value is not a record', jsonResponse({ errors: ['flat array'] }, 422)],
    ])('throws a plain HttpError for %s', async (_case, response) => {
        const error = await rejectionFor(response, HttpError);

        expect(error).not.toBeInstanceOf(HttpValidationError);
    });
});

// ---------------------------------------------------------------------------
// API error envelope
// ---------------------------------------------------------------------------

/**
 * Build an API error envelope response.
 *
 * @param status - the response status
 * @param error - the envelope's `error` object
 * @returns the response
 */
function envelopeResponse(status: number, error: Record<string, unknown>): Response {
    return jsonResponse({ error: { status, ...error } }, status);
}

/** A complete query-cost meta object. */
const COST_META = { parameter: 'filters', pointer: 'filters.$or', reason: 'nodes', limit: 100, actual: 140 };

/** The query-cost meta fields. */
const COST_FIELDS = ['parameter', 'pointer', 'reason', 'limit', 'actual'] as const;

/** A value of the wrong type for each query-cost meta field. */
const MISTYPED_COST_VALUES: Readonly<Record<(typeof COST_FIELDS)[number], unknown>> = {
    parameter: 1,
    pointer: null,
    reason: false,
    limit: '100',
    actual: '140',
};

/**
 * Build the complete query-cost meta without one of its fields.
 *
 * @param field - the field to leave out
 * @returns the meta without the field
 */
function costMetaWithout(field: (typeof COST_FIELDS)[number]): Record<string, unknown> {
    return Object.fromEntries(Object.entries(COST_META).filter(([key]) => key !== field));
}

/** Query-cost meta values that cannot be read as a cap, by description. */
const UNREADABLE_COST_META: readonly (readonly [string, unknown])[] = [
    ['absent', undefined],
    ['not a record', ['filters']],
    ...COST_FIELDS.map(field => [`missing the ${field}`, costMetaWithout(field)] as const),
    ...COST_FIELDS.map(
        field => [`mistyped on the ${field}`, { ...COST_META, [field]: MISTYPED_COST_VALUES[field] }] as const,
    ),
];

describe('FetchHttpClient - API error envelope', () => {
    it('uses the detail as the message and exposes the code and title', async () => {
        const error = await rejectionFor(
            envelopeResponse(404, { code: 10103, title: 'Not Found', detail: 'The order does not exist.' }),
            HttpError,
        );

        expect(error.message).toBe('The order does not exist.');
        expect(error.status).toBe(404);
        expect(error.code).toBe(ApiErrorCode.NotFound);
        expect(error.title).toBe('Not Found');
        expect(error.payload).toStrictEqual({
            error: { status: 404, code: 10103, title: 'Not Found', detail: 'The order does not exist.' },
        });
    });

    it('falls back to the title when the detail is absent or empty', async () => {
        const absent = await rejectionFor(envelopeResponse(403, { code: 10102, title: 'Forbidden' }), HttpError);
        const empty = await rejectionFor(
            envelopeResponse(403, { code: 10102, title: 'Forbidden', detail: '' }),
            HttpError,
        );

        expect(absent.message).toBe('Forbidden');
        expect(empty.message).toBe('Forbidden');
    });

    it('falls back to the status message and a null title when neither text field is usable', async () => {
        const error = await rejectionFor(envelopeResponse(500, { code: 10001, title: '', detail: 42 }), HttpError);

        expect(error.message).toBe('Request failed with status 500.');
        expect(error.title).toBeNull();
        expect(error.code).toBe(ApiErrorCode.UnhandledError);
    });

    it('builds an HttpValidationError from the meta field map on an invalid-input code', async () => {
        const error = await rejectionFor(
            envelopeResponse(422, {
                code: 10106,
                title: 'Invalid Input',
                meta: {
                    'order.created_at': ['The order column is not sortable.'],
                    'filters.name.$eq': ['Not a condition.', 7],
                    search: ['Too short.'],
                    ignored: 'not a list',
                },
            }),
            HttpValidationError,
        );

        expect(error.errors).toStrictEqual({
            'order.created_at': ['The order column is not sortable.'],
            'filters.name.$eq': ['Not a condition.'],
            search: ['Too short.'],
        });
        expect(error.message).toBe('Invalid Input');
        expect(error.code).toBe(ApiErrorCode.InvalidInput);
        expect(error.title).toBe('Invalid Input');
    });

    it('builds an HttpValidationError with no field errors when the invalid-input meta is absent', async () => {
        const error = await rejectionFor(
            envelopeResponse(422, { code: 10106, title: 'Invalid Input' }),
            HttpValidationError,
        );

        expect(error.errors).toStrictEqual({});
    });

    it('only reads query-cost meta on the query-too-expensive code', async () => {
        const error = await rejectionFor(
            envelopeResponse(422, { code: 10100, title: 'Bad Request', meta: COST_META }),
            HttpError,
        );

        expect(error).not.toBeInstanceOf(QueryTooExpensiveError);
    });

    it('does not build a validation error for a 422 whose code is not invalid input', async () => {
        const error = await rejectionFor(
            envelopeResponse(422, { code: 10100, title: 'Bad Request', meta: { field: ['bad'] } }),
            HttpError,
        );

        expect(error).not.toBeInstanceOf(HttpValidationError);
    });

    it('builds a QueryTooExpensiveError carrying the cap that was exceeded', async () => {
        const error = await rejectionFor(
            envelopeResponse(422, { code: 10201, title: 'Query Too Expensive', meta: COST_META }),
            QueryTooExpensiveError,
        );

        expect(error).not.toBeInstanceOf(HttpValidationError);
        expect(error.meta).toStrictEqual(COST_META);
        expect(error.code).toBe(ApiErrorCode.QueryTooExpensive);
        expect(error.title).toBe('Query Too Expensive');
    });

    it.each(
        UNREADABLE_COST_META,
    )('falls back to a plain HttpError when the query-cost meta is %s', async (_case, meta) => {
        const error = await rejectionFor(
            envelopeResponse(422, { code: 10201, title: 'Query Too Expensive', meta }),
            HttpError,
        );

        expect(error).not.toBeInstanceOf(QueryTooExpensiveError);
        expect(error.code).toBe(ApiErrorCode.QueryTooExpensive);
    });

    it('builds a MaintenanceError for the maintenance code, distinct from a plain 503', async () => {
        const maintenance = await rejectionFor(
            envelopeResponse(503, { code: 10200, title: 'Maintenance' }),
            MaintenanceError,
        );
        const unavailable = await rejectionFor(
            envelopeResponse(503, { code: 10112, title: 'Service Unavailable' }),
            HttpError,
        );

        expect(maintenance.code).toBe(ApiErrorCode.MaintenanceMode);
        expect(maintenance.message).toBe('Maintenance');
        expect(unavailable).not.toBeInstanceOf(MaintenanceError);
    });

    it.each([
        ['an error that is not a record', { error: 'boom', message: 'plain message' }],
        ['an error without a numeric code', { error: { code: '10103' }, message: 'plain message' }],
    ])('reads the plain shape when the body carries %s', async (_case, body) => {
        const error = await rejectionFor(jsonResponse(body, 404), HttpError);

        expect(error.message).toBe('plain message');
        expect(error.code).toBeNull();
        expect(error.title).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Response-error handler
// ---------------------------------------------------------------------------

describe('FetchHttpClient - response-error handler', () => {
    it('notifies the handler with the HttpError and the resolved request on a non-ok response', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ message: 'boom' }, 500));
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onResponseError });

        await expect(client.get('/fail')).rejects.toBeInstanceOf(HttpError);

        expect(onResponseError).toHaveBeenCalledTimes(1);
        const [error, request] = onResponseError.mock.calls[0] ?? [];
        expect(error).toBeInstanceOf(HttpError);
        expect(request).toStrictEqual({
            method: 'GET',
            url: 'https://api.example.com/fail',
            headers: { accept: 'application/json' },
            body: undefined,
        });
    });

    it('does not notify the handler when the request opts out with notifyOnError: false', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}, 500));
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onResponseError });

        await expect(client.get('/fail', { notifyOnError: false })).rejects.toBeInstanceOf(HttpError);

        expect(onResponseError).not.toHaveBeenCalled();
    });

    it('does not attempt to notify when no response-error handler is configured', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ message: 'boom' }, 500));
        const client = makeClient(fetchFn);

        await expect(client.get('/fail')).rejects.toBeInstanceOf(HttpError);
    });

    it('does not mask the original error when the handler throws', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ message: 'boom' }, 500));
        const onResponseError = vi.fn(() => {
            throw new Error('handler exploded');
        });
        const client = makeClient(fetchFn, { onResponseError });

        const error = await rejectionOf(client.get('/fail'), HttpError);

        expect(error.message).toBe('boom');
    });

    it('does not notify the handler when an interceptor throws before the request is resolved', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const onResponseError = vi.fn();
        const interceptor = vi.fn(() => {
            throw new Error('interceptor exploded');
        });
        const client = makeClient(fetchFn, { onResponseError, requestInterceptors: [interceptor] });

        await expect(client.get('/items')).rejects.toThrow('interceptor exploded');

        expect(onResponseError).not.toHaveBeenCalled();
        expect(fetchFn).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

describe('FetchHttpClient - download', () => {
    it('returns the response body as a Blob with the correct bytes', async () => {
        const fetchFn = makeFetch(async () => new Response(new Blob(['file bytes']), { status: 200 }));
        const client = makeClient(fetchFn);

        const result = await client.download('/files/1');

        expect(result).toBeInstanceOf(Blob);
        expect(await result.text()).toBe('file bytes');
    });

    it('dispatches downloads as GET requests', async () => {
        const fetchFn = makeFetch(async () => new Response(new Blob(['file bytes']), { status: 200 }));
        const client = makeClient(fetchFn);

        await client.download('/files/1');

        expect(fetchFn.mock.calls.at(-1)?.[1]?.method).toBe('GET');
    });

    it('maps a non-ok response to a reported HttpError', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ message: 'not found' }, 404));
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onResponseError });

        const error = await rejectionOf(client.download('/files/missing'), HttpError);

        expect(error.status).toBe(404);
        expect(onResponseError).toHaveBeenCalledWith(error, expect.objectContaining({ method: 'GET' }));
    });
});
