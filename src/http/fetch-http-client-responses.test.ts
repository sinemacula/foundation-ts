/**
 * Unit tests for FetchHttpClient - response handling (success parsing, error
 * mapping, validation errors, and blob downloads).
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import { FetchHttpClient } from './fetch-http-client';
import { HttpError, HttpValidationError } from './http-error';

// ---------------------------------------------------------------------------
// Stub type
// ---------------------------------------------------------------------------

/** Explicit overload signature so mock.calls carries a typed tuple, not []. */
type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...extra },
    });
}

function textResponse(body: string, status = 200): Response {
    return new Response(body, {
        status,
        headers: { 'content-type': 'text/plain' },
    });
}

function emptyResponse(status = 204): Response {
    return new Response(null, { status });
}

function nonJsonErrorResponse(status: number): Response {
    return new Response('<html>error</html>', {
        status,
        headers: { 'content-type': 'text/html' },
    });
}

function makeFetch(
    impl: (...args: FetchArgs) => Promise<Response>,
): ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>> {
    return vi.fn<(...args: FetchArgs) => Promise<Response>>(impl);
}

function makeClient(
    fetchFn: typeof fetch,
    extra: Partial<ConstructorParameters<typeof FetchHttpClient>[0]> = {},
): FetchHttpClient {
    return new FetchHttpClient({ baseUrl: 'https://api.example.com', fetchFn, ...extra });
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

        const result = await client.get<{ id: number; name: string }>('/users/1');

        expect(result).toStrictEqual({ id: 1, name: 'Alice' });
    });

    it('returns the raw string for a text/plain response', async () => {
        const fetchFn = makeFetch(async () => textResponse('hello world'));
        const client = makeClient(fetchFn);

        const result = await client.get<string>('/ping');

        expect(result).toBe('hello world');
    });

    it('returns the raw string when the content-type header is absent (null from headers.get)', async () => {
        // A Blob with an empty MIME type causes happy-dom to return null from
        // headers.get('content-type'), exercising the ?? fallback branch.
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
        const fetchFn = makeFetch(async () => jsonResponse({ message: 'custom error' }, 400));
        const client = makeClient(fetchFn);

        const error = await client.get('/fail').catch(error => error);

        expect(error).toBeInstanceOf(HttpError);
        // Cast proven safe: toBeInstanceOf(HttpError) assertion guards the
        // type.
        expect((error as HttpError).message).toBe('custom error');
    });

    it('uses a generic status message when payload has no message', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ code: 'E001' }, 400));
        const client = makeClient(fetchFn);

        const error = await client.get('/fail').catch(error => error);

        // Cast proven safe: toBeInstanceOf(HttpError) assertion in prior test
        // guards the same catch pattern; error is always HttpError here.
        expect((error as HttpError).message).toBe('Request failed with status 400.');
    });

    it('uses a generic status message when payload is not a record', async () => {
        const fetchFn = makeFetch(
            async () =>
                new Response('"not a record"', {
                    status: 400,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const client = makeClient(fetchFn);

        const error = await client.get('/fail').catch(error => error);

        // Cast proven safe: non-2xx response always rejects with HttpError.
        expect((error as HttpError).message).toBe('Request failed with status 400.');
    });

    it('sets payload to null when error body is not JSON', async () => {
        const fetchFn = makeFetch(async () => nonJsonErrorResponse(500));
        const client = makeClient(fetchFn);

        const error = await client.get('/fail').catch(error => error);

        // Cast proven safe: non-2xx response always rejects with HttpError.
        expect((error as HttpError).payload).toBeNull();
    });

    it('throws HttpValidationError for 422 with a valid errors record', async () => {
        const fetchFn = makeFetch(async () =>
            jsonResponse({ message: 'invalid', errors: { email: ['required'] } }, 422),
        );
        const client = makeClient(fetchFn);

        const error = await client.get('/fail').catch(error => error);

        expect(error).toBeInstanceOf(HttpValidationError);
        // Cast proven safe: toBeInstanceOf(HttpValidationError) guards the
        // type.
        expect((error as HttpValidationError).errors).toStrictEqual({ email: ['required'] });
    });

    it('filters non-string entries from validation error arrays', async () => {
        const fetchFn = makeFetch(async () =>
            jsonResponse({ errors: { field: ['valid', 42, null, 'also valid'] } }, 422),
        );
        const client = makeClient(fetchFn);

        const error = await client.get('/fail').catch(error => error);

        // Cast proven safe: toBeInstanceOf(HttpValidationError) guards the
        // type.
        expect((error as HttpValidationError).errors).toStrictEqual({ field: ['valid', 'also valid'] });
    });

    it('skips field values that are not arrays in a 422 errors record', async () => {
        const fetchFn = makeFetch(async () =>
            jsonResponse({ errors: { field: 'not an array', other: ['valid'] } }, 422),
        );
        const client = makeClient(fetchFn);

        const error = await client.get('/fail').catch(error => error);

        expect(error).toBeInstanceOf(HttpValidationError);
        // Cast proven safe: toBeInstanceOf(HttpValidationError) guards the
        // type.
        expect((error as HttpValidationError).errors).toStrictEqual({ other: ['valid'] });
    });

    it('throws plain HttpError for 422 without an errors record', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ message: 'unprocessable' }, 422));
        const client = makeClient(fetchFn);

        const error = await client.get('/fail').catch(error => error);

        expect(error).toBeInstanceOf(HttpError);
        expect(error).not.toBeInstanceOf(HttpValidationError);
    });

    it('throws plain HttpError for a non-422 response with an errors key', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ errors: { field: ['bad'] } }, 400));
        const client = makeClient(fetchFn);

        const error = await client.get('/fail').catch(error => error);

        expect(error).toBeInstanceOf(HttpError);
        expect(error).not.toBeInstanceOf(HttpValidationError);
    });

    it('throws plain HttpError for 422 where errors value is not a record', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ errors: ['flat array'] }, 422));
        const client = makeClient(fetchFn);

        const error = await client.get('/fail').catch(error => error);

        expect(error).toBeInstanceOf(HttpError);
        expect(error).not.toBeInstanceOf(HttpValidationError);
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
            headers: {},
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

        const error = await client.get('/fail').catch(error => error);

        expect(error).toBeInstanceOf(HttpError);
        // Cast proven safe: toBeInstanceOf(HttpError) guards the type.
        expect((error as HttpError).message).toBe('boom');
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

    it('maps a non-ok response to HttpError', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ message: 'not found' }, 404));
        const client = makeClient(fetchFn);

        const error = await client.download('/files/missing').catch(error => error);

        expect(error).toBeInstanceOf(HttpError);
        // Cast proven safe: toBeInstanceOf(HttpError) guards the type.
        expect((error as HttpError).status).toBe(404);
    });

    it('notifies the response-error handler when a download fails', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ message: 'not found' }, 404));
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onResponseError });

        await expect(client.download('/files/missing')).rejects.toBeInstanceOf(HttpError);

        expect(onResponseError).toHaveBeenCalledTimes(1);
    });
});
