/**
 * Unit tests for FetchHttpClient - authentication flows, network errors,
 * cancellation, default fetch fallback, and download-specific auth handling.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FetchHttpClient } from './fetch-http-client';
import { CancelledError, HttpError, NetworkError } from './http-error';

/** The body a retried request resolves with. */
interface RetriedBody {
    /** Whether the response came from the retry. */
    readonly retried: boolean;
}

/** The body the global fetch stub resolves with. */
interface GlobalBody {
    /** Whether the global fetch served the request. */
    readonly global: boolean;
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
 * @returns the response
 */
function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
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
 * Return the RequestInit from the most-recent call to a fetch stub.
 *
 * @param fn - the fetch stub
 * @returns the RequestInit object (may be undefined when not passed)
 */
function lastInit(fn: ReturnType<typeof makeFetch>): RequestInit {
    const call = fn.mock.calls.at(-1);
    expect(call).toBeDefined();
    return call?.[1] ?? {};
}

/**
 * Return the headers record from the most-recent call to a fetch stub.
 *
 * @param fn - the fetch stub
 * @returns the headers as a plain record
 */
function lastHeaders(fn: ReturnType<typeof makeFetch>): Record<string, string> {
    return (lastInit(fn).headers ?? {}) as Record<string, string>;
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

// ---------------------------------------------------------------------------
// Request interceptors
// ---------------------------------------------------------------------------

describe('FetchHttpClient - request interceptors', () => {
    it('runs zero interceptors without error', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ ok: true }));
        const client = makeClient(fetchFn, { requestInterceptors: [] });

        await expect(client.get('/ping')).resolves.toBeDefined();
    });

    it('runs a single interceptor and passes its output to fetch', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const interceptor = vi.fn(request => ({ ...request, headers: { ...request.headers, 'x-trace': '1' } }));
        const client = makeClient(fetchFn, { requestInterceptors: [interceptor] });

        await client.get('/items');

        expect(lastHeaders(fetchFn)['x-trace']).toBe('1');
    });

    it('runs interceptors in registration order', async () => {
        const order: number[] = [];
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const first = vi.fn(request => {
            order.push(1);
            return request;
        });
        const second = vi.fn(request => {
            order.push(2);
            return request;
        });
        const client = makeClient(fetchFn, { requestInterceptors: [first, second] });

        await client.get('/items');

        expect(order).toStrictEqual([1, 2]);
    });

    it('each interceptor receives the output of the previous one', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const first = vi.fn(request => ({ ...request, headers: { ...request.headers, 'x-first': 'yes' } }));
        const second = vi.fn(request => ({ ...request, headers: { ...request.headers, 'x-second': 'yes' } }));
        const client = makeClient(fetchFn, { requestInterceptors: [first, second] });

        await client.get('/items');

        const headers = lastHeaders(fetchFn);

        expect(headers['x-first']).toBe('yes');
        expect(headers['x-second']).toBe('yes');
    });

    it('handles async interceptors', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const interceptor = vi.fn(async request => ({
            ...request,
            headers: { ...request.headers, 'x-async': 'true' },
        }));
        const client = makeClient(fetchFn, { requestInterceptors: [interceptor] });

        await client.get('/items');

        expect(lastHeaders(fetchFn)['x-async']).toBe('true');
    });
});

// ---------------------------------------------------------------------------
// 401 / unauthorized handling
// ---------------------------------------------------------------------------

describe('FetchHttpClient - 401 unauthorized handling', () => {
    it('retries the request exactly once when onUnauthorized returns true', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValueOnce(new Response('', { status: 401 }))
            .mockResolvedValueOnce(jsonResponse({ retried: true }));
        const onUnauthorized = vi.fn().mockResolvedValue(true);
        const client = makeClient(fetchFn, { onUnauthorized });

        const result = await client.get<RetriedBody>('/secure');

        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(result).toStrictEqual({ retried: true });
    });

    it.each([
        ['post', (client: FetchHttpClient) => client.post<RetriedBody>('/secure', { a: 1 })],
        ['put', (client: FetchHttpClient) => client.put<RetriedBody>('/secure', { a: 1 })],
        ['patch', (client: FetchHttpClient) => client.patch<RetriedBody>('/secure', { a: 1 })],
        ['delete', (client: FetchHttpClient) => client.delete<RetriedBody>('/secure')],
    ] as const)('retries a %s once through the handler and resolves the parsed body', async (_verb, invoke) => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValueOnce(new Response('', { status: 401 }))
            .mockResolvedValueOnce(jsonResponse({ retried: true }));
        const onUnauthorized = vi.fn().mockResolvedValue(true);
        const client = makeClient(fetchFn, { onUnauthorized });

        const result = await invoke(client);

        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
        expect(result).toStrictEqual({ retried: true });
    });

    it('does not invoke the handler for a non-401 error status', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockImplementation(async () => new Response('{}', { status: 500 }));
        const onUnauthorized = vi.fn().mockResolvedValue(true);
        const client = makeClient(fetchFn, { onUnauthorized });

        await expect(client.get('/secure')).rejects.toBeInstanceOf(HttpError);

        expect(onUnauthorized).not.toHaveBeenCalled();
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('throws HttpError(401) and does not retry when onUnauthorized returns false', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockImplementation(async () => new Response('', { status: 401 }));
        const onUnauthorized = vi.fn().mockResolvedValue(false);
        const client = makeClient(fetchFn, { onUnauthorized });

        await expect(client.get('/secure')).rejects.toBeInstanceOf(HttpError);

        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('keeps the original 401 when onUnauthorized rejects', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockImplementation(async () => new Response('', { status: 401 }));
        const onUnauthorized = vi.fn().mockRejectedValue(new Error('refresh exploded'));
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onUnauthorized, onResponseError });

        const error = await rejectionOf(client.get('/secure'), HttpError);

        expect(error.status).toBe(401);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(onResponseError).toHaveBeenCalledWith(error, expect.objectContaining({ method: 'GET' }));
    });

    it('keeps the original 401 when onUnauthorized throws synchronously', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockImplementation(async () => new Response('', { status: 401 }));
        const onUnauthorized = vi.fn(() => {
            throw new Error('refresh exploded');
        });
        const client = makeClient(fetchFn, { onUnauthorized });

        const error = await rejectionOf(client.get('/secure'), HttpError);

        expect(error.status).toBe(401);
    });

    it('does not retry a second time when the retry also returns 401', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockImplementation(async () => new Response('', { status: 401 }));
        const onUnauthorized = vi.fn().mockResolvedValue(true);
        const client = makeClient(fetchFn, { onUnauthorized });

        await expect(client.get('/secure')).rejects.toBeInstanceOf(HttpError);

        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('throws HttpError(401) immediately when no onUnauthorized handler is configured', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockImplementation(async () => new Response('', { status: 401 }));
        const client = makeClient(fetchFn);

        await expect(client.get('/secure')).rejects.toBeInstanceOf(HttpError);

        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('does not invoke the handler when the request opts out of refresh', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockImplementation(async () => new Response('', { status: 401 }));
        const onUnauthorized = vi.fn().mockResolvedValue(true);
        const client = makeClient(fetchFn, { onUnauthorized });

        await expect(client.patch('/auth', {}, { retryOnUnauthorized: false })).rejects.toBeInstanceOf(HttpError);

        expect(onUnauthorized).not.toHaveBeenCalled();
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('does not notify the response-error handler when the retry recovers', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValueOnce(new Response('', { status: 401 }))
            .mockResolvedValueOnce(jsonResponse({ retried: true }));
        const onUnauthorized = vi.fn().mockResolvedValue(true);
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onUnauthorized, onResponseError });

        await client.get('/secure');

        expect(onResponseError).not.toHaveBeenCalled();
    });

    it('notifies the response-error handler once with the final error when the retry also fails', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockImplementation(async () => new Response('', { status: 401 }));
        const onUnauthorized = vi.fn().mockResolvedValue(true);
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onUnauthorized, onResponseError });

        const error = await rejectionOf(client.get('/secure'), HttpError);

        expect(onResponseError).toHaveBeenCalledTimes(1);
        expect(onResponseError).toHaveBeenCalledWith(error, expect.objectContaining({ method: 'GET' }));
    });
});

// ---------------------------------------------------------------------------
// download() - interceptors and 401 handling
// ---------------------------------------------------------------------------

describe('FetchHttpClient - download interceptors and 401 handling', () => {
    it('applies a bearer-token interceptor to download requests', async () => {
        const fetchFn = makeFetch(async () => new Response(new Blob(['bytes']), { status: 200 }));
        const bearerInterceptor = vi.fn(request => ({
            ...request,
            headers: { ...request.headers, authorization: 'Bearer token-123' },
        }));
        const client = makeClient(fetchFn, { requestInterceptors: [bearerInterceptor] });

        await client.download('/files/1');

        expect(lastHeaders(fetchFn)['authorization']).toBe('Bearer token-123');
    });

    it('retries a download exactly once when onUnauthorized returns true', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValueOnce(new Response('', { status: 401 }))
            .mockResolvedValueOnce(new Response(new Blob(['bytes']), { status: 200 }));
        const onUnauthorized = vi.fn().mockResolvedValue(true);
        const client = makeClient(fetchFn, { onUnauthorized });

        const result = await client.download('/secure-file');

        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(await result.text()).toBe('bytes');
    });

    it('does not invoke the handler for a download that opts out of refresh', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockImplementation(async () => new Response('', { status: 401 }));
        const onUnauthorized = vi.fn().mockResolvedValue(true);
        const client = makeClient(fetchFn, { onUnauthorized });

        await expect(client.download('/secure-file', { retryOnUnauthorized: false })).rejects.toBeInstanceOf(HttpError);

        expect(onUnauthorized).not.toHaveBeenCalled();
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// Network failure
// ---------------------------------------------------------------------------

describe('FetchHttpClient - network failure', () => {
    it('throws a NetworkError naming the failed request and carrying the rejection when fetch rejects', async () => {
        const cause = new TypeError('Failed to fetch');
        const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>().mockRejectedValue(cause);
        const client = makeClient(fetchFn);

        const error = await rejectionOf(client.get('/items?token=secret'), NetworkError);

        expect(error.message).toBe('GET https://api.example.com/items failed without a response.');
        expect(error.cause).toBe(cause);
    });

    it('notifies the response-error handler with the NetworkError on transport failure', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockRejectedValue(new TypeError('Failed to fetch'));
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onResponseError });

        const error = await rejectionOf(client.get('/items'), NetworkError);

        expect(onResponseError).toHaveBeenCalledTimes(1);
        expect(onResponseError).toHaveBeenCalledWith(error, expect.objectContaining({ method: 'GET' }));
    });

    it('throws NetworkError, not CancelledError, when a present signal is not aborted', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockRejectedValue(new TypeError('Failed to fetch'));
        const client = makeClient(fetchFn);
        const controller = new AbortController();

        await rejectionOf(client.get('/items', { signal: controller.signal }), NetworkError);
    });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('FetchHttpClient - cancellation', () => {
    it.each([
        ['no caller signal', undefined],
        ['a caller signal that has not aborted', new AbortController().signal],
    ])('throws a reported NetworkError for an AbortError rejection with %s', async (_case, signal) => {
        const cause = new DOMException('The operation was aborted.', 'AbortError');
        const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>().mockRejectedValue(cause);
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onResponseError });

        const error = await rejectionOf(client.get('/items', signal === undefined ? {} : { signal }), NetworkError);

        expect(error.message).toBe('GET https://api.example.com/items failed without a response.');
        expect(error.cause).toBe(cause);
        expect(onResponseError).toHaveBeenCalledWith(error, expect.objectContaining({ method: 'GET' }));
    });

    it('throws CancelledError when the caller aborts, whatever the rejection is named', async () => {
        const cause = new Error('aborted');
        const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>().mockRejectedValue(cause);
        const client = makeClient(fetchFn);

        const error = await rejectionOf(client.get('/items', { signal: AbortSignal.abort() }), CancelledError);

        expect(error.message).toBe('GET https://api.example.com/items was cancelled.');
        expect(error.cause).toBe(cause);
    });

    it('does not notify the response-error handler on cancellation', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onResponseError });

        await rejectionOf(client.get('/items', { signal: AbortSignal.abort() }), CancelledError);

        expect(onResponseError).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Default fetchFn - uses globalThis.fetch
// ---------------------------------------------------------------------------

describe('FetchHttpClient - default fetchFn', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('falls back to globalThis.fetch when no fetchFn is provided', async () => {
        const stub = makeFetch(async () => jsonResponse({ global: true }));
        vi.stubGlobal('fetch', stub);

        const client = new FetchHttpClient({ baseUrl: 'https://api.example.com' });

        const result = await client.get<GlobalBody>('/test');

        expect(stub).toHaveBeenCalledOnce();
        expect(result).toStrictEqual({ global: true });
    });
});

// ---------------------------------------------------------------------------
// RN runtime fallbacks
// ---------------------------------------------------------------------------

describe('FetchHttpClient - runtime fallbacks', () => {
    it('treats a non-object fetch rejection as a network failure', async () => {
        const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>().mockRejectedValue('boom');
        const client = makeClient(fetchFn);

        await rejectionOf(client.get('/items'), NetworkError);
    });

    it('treats a null fetch rejection as a network failure', async () => {
        const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>().mockRejectedValue(null);
        const client = makeClient(fetchFn);

        await rejectionOf(client.get('/items'), NetworkError);
    });
});
