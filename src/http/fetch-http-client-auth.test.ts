/**
 * Unit tests for FetchHttpClient - authentication flows, network errors,
 * signal/timeout, default fetch fallback, and download-specific auth handling.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FetchHttpClient } from './fetch-http-client';
import { CancelledError, HttpError, NetworkError } from './http-error';

// ---------------------------------------------------------------------------
// Stub type
// ---------------------------------------------------------------------------

/** Explicit overload signature so mock.calls carries a typed tuple, not []. */
type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
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
 * A fetch stub that mimics real fetch's abort behaviour: it rejects as soon as
 * its signal aborts, whether that has already happened by the time fetch is
 * called or happens later while the request is pending.
 *
 * @returns the fetch stub
 */
function makeAbortAwareFetch(): ReturnType<typeof makeFetch> {
    return makeFetch(
        (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;

                if (signal === undefined || signal === null) {
                    return;
                }

                const rejectWithReason = (): void => {
                    reject(signal.reason);
                };

                if (signal.aborted) {
                    rejectWithReason();
                    return;
                }

                signal.addEventListener('abort', rejectWithReason);
            }),
    );
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

        // Cast proven safe: #buildRequestInit always writes a plain object
        // literal.
        expect((lastInit(fetchFn).headers as Record<string, string>)['x-trace']).toBe('1');
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

        // Cast proven safe: #buildRequestInit always writes a plain object
        // literal.
        const headers = lastInit(fetchFn).headers as Record<string, string>;

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

        // Cast proven safe: #buildRequestInit always writes a plain object
        // literal.
        expect((lastInit(fetchFn).headers as Record<string, string>)['x-async']).toBe('true');
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

        const result = await client.get<{ retried: boolean }>('/secure');

        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(result).toStrictEqual({ retried: true });
    });

    it('throws HttpError(401) and does not retry when onUnauthorized returns false', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValue(new Response('', { status: 401 }));
        const onUnauthorized = vi.fn().mockResolvedValue(false);
        const client = makeClient(fetchFn, { onUnauthorized });

        await expect(client.get('/secure')).rejects.toBeInstanceOf(HttpError);

        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('does not retry a second time when the retry also returns 401', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValue(new Response('', { status: 401 }));
        const onUnauthorized = vi.fn().mockResolvedValue(true);
        const client = makeClient(fetchFn, { onUnauthorized });

        await expect(client.get('/secure')).rejects.toBeInstanceOf(HttpError);

        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('throws HttpError(401) immediately when no onUnauthorized handler is configured', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValue(new Response('', { status: 401 }));
        const client = makeClient(fetchFn);

        await expect(client.get('/secure')).rejects.toBeInstanceOf(HttpError);

        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('does not invoke the handler when the request opts out of refresh', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValue(new Response('', { status: 401 }));
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
            .mockResolvedValue(new Response('', { status: 401 }));
        const onUnauthorized = vi.fn().mockResolvedValue(true);
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onUnauthorized, onResponseError });

        const error = await client.get('/secure').catch(error => error);

        expect(error).toBeInstanceOf(HttpError);
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

        // Cast proven safe: #buildRequestInit always writes a plain object
        // literal.
        expect((lastInit(fetchFn).headers as Record<string, string>)['authorization']).toBe('Bearer token-123');
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
            .mockResolvedValue(new Response('', { status: 401 }));
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
    it('throws NetworkError when fetch rejects', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockRejectedValue(new TypeError('Failed to fetch'));
        const client = makeClient(fetchFn);

        await expect(client.get('/items')).rejects.toBeInstanceOf(NetworkError);
    });

    it('sets the cause on NetworkError', async () => {
        const cause = new TypeError('Failed to fetch');
        const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>().mockRejectedValue(cause);
        const client = makeClient(fetchFn);

        const error = await client.get('/items').catch(error => error);

        // Cast proven safe: rejects.toBeInstanceOf(NetworkError) is the same
        // catch pattern; error is always NetworkError when fetch rejects.
        expect((error as NetworkError).cause).toBe(cause);
    });

    it('notifies the response-error handler with the NetworkError on transport failure', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockRejectedValue(new TypeError('Failed to fetch'));
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onResponseError });

        const error = await client.get('/items').catch(error => error);

        expect(error).toBeInstanceOf(NetworkError);
        expect(onResponseError).toHaveBeenCalledTimes(1);
        expect(onResponseError).toHaveBeenCalledWith(error, expect.objectContaining({ method: 'GET' }));
    });

    it('throws NetworkError, not CancelledError, when a present signal is not aborted', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockRejectedValue(new TypeError('Failed to fetch'));
        const client = makeClient(fetchFn);
        const controller = new AbortController();

        const error = await client.get('/items', { signal: controller.signal }).catch(error => error);

        expect(error).toBeInstanceOf(NetworkError);
    });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('FetchHttpClient - cancellation', () => {
    it('throws CancelledError when the fetch rejection is an AbortError, even without a caller signal', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
        const client = makeClient(fetchFn);

        const error = await client.get('/items').catch(error => error);

        expect(error).toBeInstanceOf(CancelledError);
    });

    it('throws CancelledError when the caller aborts, even without an AbortError-named rejection', async () => {
        const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>().mockRejectedValue(new Error('aborted'));
        const client = makeClient(fetchFn);
        const controller = new AbortController();

        controller.abort();

        const error = await client.get('/items', { signal: controller.signal }).catch(error => error);

        expect(error).toBeInstanceOf(CancelledError);
    });

    it('does not notify the response-error handler on cancellation', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onResponseError });
        const controller = new AbortController();

        controller.abort();

        await client.get('/items', { signal: controller.signal }).catch(() => undefined);

        expect(onResponseError).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Signal / timeout
// ---------------------------------------------------------------------------

describe('FetchHttpClient - signal and timeout', () => {
    it('passes the caller signal when provided', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn);
        const signal = AbortSignal.abort();

        // Swallow the expected AbortError: the test goal is to verify the
        // signal was forwarded to fetch, not to observe the rejection.
        await client.get('/items', { signal }).catch(() => undefined);

        expect(lastInit(fetchFn).signal).toBe(signal);
    });

    it('creates a timeout AbortSignal when timeout is set and no signal is provided', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn, { timeout: 5000 });

        await client.get('/items');

        expect(lastInit(fetchFn).signal).toBeInstanceOf(AbortSignal);
    });

    it('passes null as the signal when no timeout and no signal are set', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn);

        await client.get('/items');

        expect(lastInit(fetchFn).signal).toBeNull();
    });

    it('composes the caller signal with the timeout signal so the timeout still fires', async () => {
        const timeoutController = new AbortController();
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);
        const fetchFn = makeAbortAwareFetch();
        const client = makeClient(fetchFn, { timeout: 5_000 });
        const callerController = new AbortController();

        const pending = client.get('/items', { signal: callerController.signal }).catch(error => error);

        timeoutController.abort(new DOMException('The operation timed out.', 'TimeoutError'));

        const error = await pending;

        expect(error).toBeInstanceOf(CancelledError);
        expect(callerController.signal.aborted).toBe(false);

        timeoutSpy.mockRestore();
    });

    it('does not disable the caller signal when a timeout is also configured', async () => {
        const timeoutController = new AbortController();
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);
        const fetchFn = makeAbortAwareFetch();
        const client = makeClient(fetchFn, { timeout: 5_000 });
        const callerController = new AbortController();

        const pending = client.get('/items', { signal: callerController.signal }).catch(error => error);

        callerController.abort();

        const error = await pending;

        expect(error).toBeInstanceOf(CancelledError);

        timeoutSpy.mockRestore();
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

        const result = await client.get<{ global: boolean }>('/test');

        expect(stub).toHaveBeenCalledOnce();
        expect(result).toStrictEqual({ global: true });
    });
});
