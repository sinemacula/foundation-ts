/**
 * Tests for FetchHttpClient interceptors, 401 handling and transport failures.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBearerTokenInterceptor } from './bearer-token-interceptor';
import { FetchHttpClient } from './fetch-http-client';
import type { HttpRequest, UnauthorizedHandler } from './http-client';
import { CancelledError, HttpError, NetworkError } from './http-error';
import { TokenRefreshCoordinator } from './token-refresh-coordinator';

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

/** The fetch call signature, so mock.calls carries a typed tuple. */
type FetchArgs = [input: Request | string | URL, init?: RequestInit];

/** A constructor of the error type a rejection is expected to have. */
type ErrorType<E extends Error> = new (...args: never[]) => E;

/** A promise plus its externally callable settlers. */
interface Deferred<T> {
    /** The controlled promise. */
    readonly promise: Promise<T>;

    /** Settle the promise successfully. */
    readonly resolve: (value: T) => void;

    /** Settle the promise with a failure. */
    readonly reject: (reason?: unknown) => void;
}

/** How a probed promise has settled so far. */
interface SettleProbe {
    /** Whether the promise is still pending, or how it settled. */
    readonly state: 'pending' | 'resolved' | 'rejected';

    /** The resolved value or rejection reason, once settled. */
    readonly value: unknown;
}

/**
 * Create a promise whose settlement the test controls.
 */
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((resolveValue, rejectValue) => {
        resolve = resolveValue;
        reject = rejectValue;
    });

    return { promise, resolve, reject };
}

/**
 * Track a promise's settlement without awaiting it.
 */
function probe(promise: Promise<unknown>): SettleProbe {
    const result: { -readonly [K in keyof SettleProbe]: SettleProbe[K] } = { state: 'pending', value: undefined };

    promise.then(
        value => {
            result.state = 'resolved';
            result.value = value;
        },
        (error: unknown) => {
            result.state = 'rejected';
            result.value = error;
        },
    );

    return result;
}

/**
 * Let every pending promise continuation run.
 */
function flush(): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, 0);
    });
}

/**
 * Build a 401 response.
 */
function unauthorized(): Response {
    return new Response('', { status: 401 });
}

/**
 * Build a JSON response.
 */
function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

/**
 * Wrap a fetch implementation in a typed stub.
 */
function makeFetch(
    impl: (...args: FetchArgs) => Promise<Response>,
): ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>> {
    return vi.fn<(...args: FetchArgs) => Promise<Response>>(impl);
}

/**
 * Build a client against the stub with optional extra options.
 */
function makeClient(
    fetchFn: typeof fetch,
    extra: Partial<ConstructorParameters<typeof FetchHttpClient>[0]> = {},
): FetchHttpClient {
    return new FetchHttpClient({ baseUrl: 'https://api.example.com', fetchFn, ...extra });
}

/**
 * Return the RequestInit from the most recent call to a fetch stub, or an empty
 * one when none was passed.
 */
function lastInit(fn: ReturnType<typeof makeFetch>): RequestInit {
    const call = fn.mock.calls.at(-1);
    expect(call).toBeDefined();
    return call?.[1] ?? {};
}

/**
 * Return the headers record from the most recent call to a fetch stub.
 */
function lastHeaders(fn: ReturnType<typeof makeFetch>): Record<string, string> {
    return (lastInit(fn).headers ?? {}) as Record<string, string>;
}

/**
 * Read the authorization header from a fetch init.
 */
function authorizationOf(init: RequestInit | undefined): string | undefined {
    return ((init?.headers ?? {}) as Record<string, string>)['authorization'];
}

/**
 * Return the authorization header sent on every call to a fetch stub.
 */
function sentAuthorizations(fn: ReturnType<typeof makeFetch>): (string | undefined)[] {
    return fn.mock.calls.map(([, init]) => authorizationOf(init));
}

/**
 * Await a request expected to reject with a given error type.
 */
async function rejectionOf<E extends Error>(promise: Promise<unknown>, type: ErrorType<E>): Promise<E> {
    const error = await promise.catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(type);

    return error as E;
}

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

    it('passes each interceptor the output of the one before', async () => {
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

describe('FetchHttpClient - 401 unauthorized handling', () => {
    it.each([
        ['get', (client: FetchHttpClient) => client.get<RetriedBody>('/secure')],
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

    it('rejects with the 401 without retrying when the refresh fails', async () => {
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

    it('rejects with the 401 when no unauthorized handler is configured', async () => {
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

    it('notifies the response-error handler once when the retry also fails', async () => {
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

describe('FetchHttpClient - 401 retry credentials', () => {
    it('re-runs the interceptors so the retry carries the rotated token', async () => {
        let token = 'old';
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValueOnce(unauthorized())
            .mockResolvedValueOnce(jsonResponse({ retried: true }));
        const client = makeClient(fetchFn, {
            requestInterceptors: [createBearerTokenInterceptor({ getAccessToken: () => token })],
            onUnauthorized: () => {
                token = 'new';

                return Promise.resolve(true);
            },
        });

        await expect(client.get('/secure')).resolves.toStrictEqual({ retried: true });

        expect(sentAuthorizations(fetchFn)).toStrictEqual(['Bearer old', 'Bearer new']);
    });

    it.each([
        ['GET', undefined, (client: FetchHttpClient) => client.get('/secure?page=2', { headers: { 'X-Trace': 't' } })],
        [
            'POST',
            { a: 1 },
            (client: FetchHttpClient) => client.post('/secure?page=2', { a: 1 }, { headers: { 'X-Trace': 't' } }),
        ],
    ] as const)('hands the handler the resolved %s that received the 401', async (method, body, invoke) => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValueOnce(unauthorized())
            .mockResolvedValueOnce(jsonResponse({ retried: true }));
        const onUnauthorized = vi.fn<UnauthorizedHandler>().mockResolvedValue(true);
        const client = makeClient(fetchFn, {
            requestInterceptors: [createBearerTokenInterceptor({ getAccessToken: () => 'A1' })],
            onUnauthorized,
        });

        await invoke(client);

        expect(onUnauthorized.mock.calls).toStrictEqual([
            [
                {
                    method,
                    url: 'https://api.example.com/secure?page=2',
                    headers: { accept: 'application/json', 'x-trace': 't', authorization: 'Bearer A1' },
                    body,
                },
            ],
        ]);
    });

    it('hands the handler an explicit authorization unchanged', async () => {
        const fetchFn = makeFetch(async () => unauthorized());
        const onUnauthorized = vi.fn<UnauthorizedHandler>().mockResolvedValue(false);
        const client = makeClient(fetchFn, {
            requestInterceptors: [createBearerTokenInterceptor({ getAccessToken: () => 'A1' })],
            onUnauthorized,
        });

        await rejectionOf(client.get('/secure', { headers: { Authorization: 'Basic x' } }), HttpError);

        expect(onUnauthorized.mock.calls[0]?.[0].headers['authorization']).toBe('Basic x');
    });
});

describe('FetchHttpClient - re-entrant refresh', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('rejects with the 401 when the refresh posts through the same client with the handler disabled', async () => {
        const fetchFn = makeFetch(async () => unauthorized());
        const refresh = vi.fn(() =>
            client.post('/auth/refresh', {}, { retryOnUnauthorized: false }).then(
                () => true,
                () => false,
            ),
        );
        const coordinator = new TokenRefreshCoordinator({ refresh });
        const client = makeClient(fetchFn, { onUnauthorized: () => coordinator.refresh() });

        const settled = probe(client.get('/secure'));

        await vi.runAllTimersAsync();

        expect(settled.state).toBe('rejected');
        expect(settled.value).toBeInstanceOf(HttpError);
        expect((settled.value as HttpError).status).toBe(401);
        expect(refresh).toHaveBeenCalledOnce();
        expect(fetchFn.mock.calls.map(([input, init]) => `${String(init?.method)} ${String(input)}`)).toStrictEqual([
            'GET https://api.example.com/secure',
            'POST https://api.example.com/auth/refresh',
        ]);
    });

    it('lets the caller abandon a refresh that never settles', async () => {
        const fetchFn = makeFetch(async () => unauthorized());
        const invoked = deferred<undefined>();
        const stuck = deferred<boolean>();
        const caller = new AbortController();
        const client = makeClient(fetchFn, {
            onUnauthorized: () => {
                invoked.resolve(undefined);

                return stuck.promise;
            },
        });

        try {
            const settled = probe(client.get('/secure', { signal: caller.signal }));

            await invoked.promise;
            await vi.runAllTimersAsync();

            expect(settled.state).toBe('pending');

            caller.abort();
            await vi.runAllTimersAsync();

            expect(settled.state).toBe('rejected');
            expect(settled.value).toBeInstanceOf(CancelledError);
            expect(fetchFn).toHaveBeenCalledOnce();
        } finally {
            stuck.resolve(false);
        }
    });
});

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

describe('FetchHttpClient - network failure', () => {
    it('throws a NetworkError naming the request when fetch rejects', async () => {
        const cause = new TypeError('Failed to fetch');
        const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>().mockRejectedValue(cause);
        const client = makeClient(fetchFn);

        const error = await rejectionOf(client.get('/items?token=secret'), NetworkError);

        expect(error.message).toBe('GET https://api.example.com/items failed without a response.');
        expect(error.cause).toBe(cause);
    });

    it('notifies the response-error handler of the NetworkError', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockRejectedValue(new TypeError('Failed to fetch'));
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onResponseError });

        const error = await rejectionOf(client.get('/items'), NetworkError);

        expect(onResponseError).toHaveBeenCalledTimes(1);
        expect(onResponseError).toHaveBeenCalledWith(error, expect.objectContaining({ method: 'GET' }));
    });

    it('throws a NetworkError when the caller signal has not aborted', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockRejectedValue(new TypeError('Failed to fetch'));
        const client = makeClient(fetchFn);
        const controller = new AbortController();

        await rejectionOf(client.get('/items', { signal: controller.signal }), NetworkError);
    });
});

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

    it('throws CancelledError when the caller aborts in flight, whatever the rejection is named', async () => {
        const cause = new Error('aborted');
        const caller = new AbortController();
        const fetchFn = makeFetch(() => {
            caller.abort();

            return Promise.reject(cause);
        });
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onResponseError });

        const error = await rejectionOf(client.get('/items', { signal: caller.signal }), CancelledError);

        expect(error.message).toBe('GET https://api.example.com/items was cancelled.');
        expect(error.cause).toBe(cause);
        expect(onResponseError).not.toHaveBeenCalled();
    });
});

describe('FetchHttpClient - cancellation while not in flight', () => {
    /** Builds a client whose request waits on a gate before or after its first fetch. */
    type GatedClientFactory = (
        fetchFn: typeof fetch,
        gate: Promise<undefined>,
        onResponseError: () => void,
    ) => FetchHttpClient;

    const gatedOn: ReadonlyArray<readonly [string, number, GatedClientFactory]> = [
        [
            'an async interceptor',
            0,
            (fetchFn, gate, onResponseError) =>
                makeClient(fetchFn, {
                    onResponseError,
                    requestInterceptors: [
                        async (request: HttpRequest) => {
                            await gate;

                            return request;
                        },
                    ],
                }),
        ],
        [
            'the unauthorized handler',
            1,
            (fetchFn, gate, onResponseError) =>
                makeClient(fetchFn, { onResponseError, onUnauthorized: () => gate.then(() => true) }),
        ],
    ];

    it.each(gatedOn)('rejects at once when the caller aborts while %s is pending', async (_case, fetches, build) => {
        const fetchFn = makeFetch(async () => unauthorized());
        const gate = deferred<undefined>();
        const onResponseError = vi.fn();
        const caller = new AbortController();
        const reason = new Error('navigated away');
        const client = build(fetchFn, gate.promise, onResponseError);

        const settled = probe(client.get('/secure?token=secret', { signal: caller.signal }));

        await flush();
        caller.abort(reason);
        await flush();

        expect(settled.state).toBe('rejected');
        expect(settled.value).toBeInstanceOf(CancelledError);
        expect((settled.value as CancelledError).message).toBe('GET https://api.example.com/secure was cancelled.');
        expect((settled.value as CancelledError).cause).toBe(reason);
        expect(fetchFn).toHaveBeenCalledTimes(fetches);

        gate.resolve(undefined);
        await flush();

        expect(fetchFn).toHaveBeenCalledTimes(fetches);
        expect(onResponseError).not.toHaveBeenCalled();
    });

    it.each(gatedOn)('handles %s rejecting after the caller aborted', async (_case, _fetches, build) => {
        const fetchFn = makeFetch(async () => unauthorized());
        const gate = deferred<undefined>();
        const caller = new AbortController();
        const client = build(fetchFn, gate.promise, vi.fn());

        const settled = probe(client.get('/secure', { signal: caller.signal }));

        await flush();
        caller.abort();
        gate.reject(new Error('late failure'));
        await flush();

        expect(settled.value).toBeInstanceOf(CancelledError);
    });

    it.each(gatedOn)('prefers the abort when %s settles in the same tick', async (_case, fetches, build) => {
        const fetchFn = makeFetch(async () => unauthorized());
        const gate = deferred<undefined>();
        const caller = new AbortController();
        const client = build(fetchFn, gate.promise, vi.fn());

        const settled = probe(client.get('/secure', { signal: caller.signal }));

        await flush();
        gate.resolve(undefined);
        caller.abort();
        await flush();

        expect(settled.value).toBeInstanceOf(CancelledError);
        expect(fetchFn).toHaveBeenCalledTimes(fetches);
    });

    it('never invokes the handler when the caller aborts as the 401 arrives', async () => {
        const caller = new AbortController();
        const reason = new Error('navigated away');
        const fetchFn = makeFetch(() => {
            caller.abort(reason);

            return Promise.resolve(unauthorized());
        });
        const onUnauthorized = vi.fn<UnauthorizedHandler>().mockResolvedValue(true);
        const client = makeClient(fetchFn, { onUnauthorized });

        const error = await rejectionOf(client.get('/secure', { signal: caller.signal }), CancelledError);

        expect(error.message).toBe('GET https://api.example.com/secure was cancelled.');
        expect(error.cause).toBe(reason);
        expect(onUnauthorized).not.toHaveBeenCalled();
        expect(fetchFn).toHaveBeenCalledOnce();
    });

    it.each([
        ['no handler is set', {}, {}],
        [
            'the request opts out of the handler',
            { onUnauthorized: () => Promise.resolve(true) },
            { retryOnUnauthorized: false },
        ],
    ])('keeps a 401 the caller aborted as it arrived when %s', async (_case, extra, options) => {
        const caller = new AbortController();
        const fetchFn = makeFetch(() => {
            caller.abort();

            return Promise.resolve(unauthorized());
        });
        const client = makeClient(fetchFn, extra);

        const error = await rejectionOf(client.get('/secure', { ...options, signal: caller.signal }), HttpError);

        expect(error.status).toBe(401);
        expect(fetchFn).toHaveBeenCalledOnce();
    });

    it('runs no interceptor and no fetch for an already-aborted signal', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const interceptor = vi.fn((request: HttpRequest) => request);
        const reason = new Error('gone');
        const client = makeClient(fetchFn, { requestInterceptors: [interceptor] });

        const error = await rejectionOf(client.get('/items', { signal: AbortSignal.abort(reason) }), CancelledError);

        expect(error.message).toBe('GET https://api.example.com/items was cancelled.');
        expect(error.cause).toBe(reason);
        expect(interceptor).not.toHaveBeenCalled();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('runs no later interceptor once the caller aborts between two', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const caller = new AbortController();
        const second = vi.fn((request: HttpRequest) => request);
        const client = makeClient(fetchFn, {
            requestInterceptors: [
                request => {
                    caller.abort();

                    return request;
                },
                second,
            ],
        });

        await rejectionOf(client.get('/items', { signal: caller.signal }), CancelledError);

        expect(second).not.toHaveBeenCalled();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('cancels without a cause when an aborted signal carries no reason', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const signal = Object.assign(new EventTarget(), { aborted: true, reason: undefined }) as unknown as AbortSignal;
        const client = makeClient(fetchFn);

        const error = await rejectionOf(client.get('/items', { signal }), CancelledError);

        expect(error.cause).toBeUndefined();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('lets one caller leave a shared refresh while another completes it', async () => {
        let token = 'old';
        const gate = deferred<undefined>();
        const fetchFn = makeFetch(async (_input, init) =>
            authorizationOf(init) === 'Bearer old' ? unauthorized() : jsonResponse({ ok: true }),
        );
        const refresh = vi.fn(async () => {
            await gate.promise;
            token = 'new';

            return true;
        });
        const coordinator = new TokenRefreshCoordinator({ refresh });
        const leaving = new AbortController();
        const client = makeClient(fetchFn, {
            requestInterceptors: [createBearerTokenInterceptor({ getAccessToken: () => token })],
            onUnauthorized: () => coordinator.refresh(),
        });

        const left = probe(client.get('/a', { signal: leaving.signal }));
        const stayed = client.get('/b');

        await flush();
        leaving.abort();
        await flush();

        expect(left.value).toBeInstanceOf(CancelledError);

        gate.resolve(undefined);

        await expect(stayed).resolves.toStrictEqual({ ok: true });
        expect(refresh).toHaveBeenCalledOnce();
        expect(fetchFn).toHaveBeenCalledTimes(3);
    });
});

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

describe('FetchHttpClient - runtime fallbacks', () => {
    it.each([
        ['non-object', 'boom'],
        ['null', null],
    ])('treats a %s fetch rejection as a network failure', async (_case, rejection) => {
        const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>().mockRejectedValue(rejection);
        const client = makeClient(fetchFn);

        await rejectionOf(client.get('/items'), NetworkError);
    });
});
