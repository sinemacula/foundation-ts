/**
 * Tests for the FetchHttpClient opt-in transient retry policy.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExponentialBackoff } from '../realtime/exponential-backoff';
import { createBearerTokenInterceptor } from './bearer-token-interceptor';
import { FetchHttpClient } from './fetch-http-client';
import type { RequestInterceptor, ResponseErrorHandler, UnauthorizedHandler } from './http-client';
import { CancelledError, HttpError, MaintenanceError, NetworkError } from './http-error';

/** The body a recovered retry resolves with. */
interface RecoveredBody {
    /** Whether the retry recovered. */
    readonly recovered: boolean;
}

/** The fetch call signature, so mock.calls carries a typed tuple. */
type FetchArgs = [input: Request | string | URL, init?: RequestInit];

/** A constructor of the error type a rejection is expected to have. */
type ErrorType<E extends Error> = new (...args: never[]) => E;

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
 * Build a client against the stub with optional extra options.
 */
function makeClient(
    fetchFn: typeof fetch,
    extra: Partial<ConstructorParameters<typeof FetchHttpClient>[0]> = {},
): FetchHttpClient {
    return new FetchHttpClient({ baseUrl: 'https://api.example.com', fetchFn, ...extra });
}

/**
 * Await a request expected to reject with a given error type.
 */
async function rejectionOf<E extends Error>(promise: Promise<unknown>, type: ErrorType<E>): Promise<E> {
    const error = await promise.catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(type);

    return error as E;
}

/** A retrying client and the handler stubs it was built with. */
interface RotatingClient {
    /** The client under test. */
    readonly client: FetchHttpClient;

    /** The unauthorized handler, advancing the token on each call. */
    readonly onUnauthorized: ReturnType<typeof vi.fn<UnauthorizedHandler>>;

    /** The response-error handler. */
    readonly onResponseError: ReturnType<typeof vi.fn<ResponseErrorHandler>>;
}

/**
 * Build a backoff that always waits the given delay.
 */
function fixedBackoff(delay: number): ExponentialBackoff {
    return new ExponentialBackoff({ initialDelay: delay, multiplier: 1, maxDelay: delay });
}

/**
 * Build a fetch stub answering each call with the next status in turn, a 200
 * carrying JSON and any other status an empty body.
 */
function statusSequence(
    statuses: readonly number[],
): ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>> {
    const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>();

    for (const status of statuses) {
        fetchFn.mockImplementationOnce(async () =>
            status === 200 ? jsonResponse({ recovered: true }) : new Response('', { status }),
        );
    }

    return fetchFn;
}

describe('FetchHttpClient - transient retry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('recovers from a 503 after the backoff delay', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValueOnce(jsonResponse({}, 503))
            .mockResolvedValueOnce(jsonResponse({ recovered: true }));
        const client = makeClient(fetchFn, { retry: { attempts: 2, backoff: fixedBackoff(100) } });

        const pending = client.get<RecoveredBody>('/items');

        await vi.advanceTimersByTimeAsync(99);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(fetchFn).toHaveBeenCalledTimes(2);

        await expect(pending).resolves.toStrictEqual({ recovered: true });
    });

    it('recovers from a NetworkError', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(jsonResponse({ recovered: true }));
        const client = makeClient(fetchFn, { retry: { attempts: 2, backoff: fixedBackoff(50) } });

        const pending = client.get<RecoveredBody>('/items');

        await vi.advanceTimersByTimeAsync(50);

        await expect(pending).resolves.toStrictEqual({ recovered: true });
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it.each([
        [0, 500, 1_000],
        [0.5, 750, 1_500],
    ])('defaults to two equal-jittered retries (random %s waits %s ms, then %s ms)', async (sample, first, second) => {
        vi.spyOn(Math, 'random').mockReturnValue(sample);

        const fetchFn = statusSequence([503, 503, 200]);
        const client = makeClient(fetchFn, { retry: {} });

        const pending = client.get<RecoveredBody>('/items');

        await vi.advanceTimersByTimeAsync(first - 1);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(fetchFn).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(second - 1);
        expect(fetchFn).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(1);
        expect(fetchFn).toHaveBeenCalledTimes(3);

        await expect(pending).resolves.toStrictEqual({ recovered: true });
    });

    it('throws the final error with one notification once the budget is spent', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockImplementation(async () => jsonResponse({}, 503));
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, {
            retry: { attempts: 1, backoff: fixedBackoff(10) },
            onResponseError,
        });

        const pending = rejectionOf(client.get('/items'), HttpError);

        await vi.advanceTimersByTimeAsync(10);

        const error = await pending;

        expect(error.status).toBe(503);
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(onResponseError).toHaveBeenCalledTimes(1);
        expect(onResponseError).toHaveBeenCalledWith(error, expect.objectContaining({ method: 'GET' }));
    });

    it.each([
        ['POST', (client: FetchHttpClient) => client.post('/items', {})],
        ['PUT', (client: FetchHttpClient) => client.put('/items', {})],
        ['PATCH', (client: FetchHttpClient) => client.patch('/items', {})],
        ['DELETE', (client: FetchHttpClient) => client.delete('/items')],
    ] as const)('does not retry a %s even when retry is configured', async (_verb, invoke) => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockImplementation(async () => jsonResponse({}, 503));
        const client = makeClient(fetchFn, { retry: { attempts: 2, backoff: fixedBackoff(10) } });

        await expect(invoke(client)).rejects.toBeInstanceOf(HttpError);

        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('does not retry a 500 status', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockImplementation(async () => jsonResponse({}, 500));
        const client = makeClient(fetchFn, { retry: { attempts: 2, backoff: fixedBackoff(10) } });

        await expect(client.get('/items')).rejects.toBeInstanceOf(HttpError);

        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('does not retry a maintenance 503', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockImplementation(async () =>
                jsonResponse({ error: { status: 503, code: 10200, title: 'Maintenance' } }, 503),
            );
        const client = makeClient(fetchFn, { retry: { attempts: 2, backoff: fixedBackoff(10) } });

        await expect(client.get('/items')).rejects.toBeInstanceOf(MaintenanceError);

        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('accepts any backoff exposing delayFor', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValueOnce(jsonResponse({}, 502))
            .mockResolvedValueOnce(jsonResponse({ recovered: true }));
        const delayFor = vi.fn((): number => 25);
        const client = makeClient(fetchFn, { retry: { attempts: 1, backoff: { delayFor } } });

        const pending = client.get<RecoveredBody>('/items');

        await vi.advanceTimersByTimeAsync(24);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);

        await expect(pending).resolves.toStrictEqual({ recovered: true });
        expect(delayFor).toHaveBeenCalledWith(0);
    });

    it.each([
        ['the timer maximum', 2_147_483_647],
        ['one above the timer maximum', 2_147_483_648],
        ['Infinity', Number.POSITIVE_INFINITY],
    ])('waits the timer maximum for a custom delay of %s', async (_case, delay) => {
        const fetchFn = statusSequence([503, 200]);
        const client = makeClient(fetchFn, { retry: { attempts: 1, backoff: { delayFor: () => delay } } });

        const pending = client.get<RecoveredBody>('/items');

        await vi.advanceTimersByTimeAsync(2_147_483_646);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);

        await expect(pending).resolves.toStrictEqual({ recovered: true });
    });

    it('cancels a wait on a clamped delay when the caller aborts', async () => {
        const caller = new AbortController();
        const fetchFn = statusSequence([503, 200]);
        const client = makeClient(fetchFn, {
            retry: { attempts: 1, backoff: { delayFor: () => Number.POSITIVE_INFINITY } },
        });

        const pending = rejectionOf(client.get('/items', { signal: caller.signal }), CancelledError);

        await vi.advanceTimersByTimeAsync(1_000);
        caller.abort();

        expect((await pending).message).toBe('GET https://api.example.com/items was cancelled before its retry.');
        expect(fetchFn).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not retry a transient status when no retry policy is configured', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockImplementation(async () => jsonResponse({}, 503));
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onResponseError });

        await expect(client.get('/items')).rejects.toBeInstanceOf(HttpError);

        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(onResponseError).toHaveBeenCalledTimes(1);
    });

    it('retries a download like a GET', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValueOnce(jsonResponse({}, 503))
            .mockResolvedValueOnce(new Response(new Blob(['bytes']), { status: 200 }));
        const client = makeClient(fetchFn, { retry: { attempts: 2, backoff: fixedBackoff(10) } });

        const pending = client.download('/files/1');

        await vi.advanceTimersByTimeAsync(10);

        const result = await pending;

        expect(await result.text()).toBe('bytes');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('retries a transport failure thrown by an interceptor', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValueOnce(jsonResponse({ recovered: true }));
        const interceptor = vi
            .fn<RequestInterceptor>()
            .mockImplementationOnce(() => {
                throw new NetworkError('token refresh failed');
            })
            .mockImplementationOnce(request => request);
        const client = makeClient(fetchFn, {
            retry: { attempts: 1, backoff: fixedBackoff(10) },
            requestInterceptors: [interceptor],
        });

        const pending = client.get<RecoveredBody>('/items');

        await vi.advanceTimersByTimeAsync(10);

        await expect(pending).resolves.toStrictEqual({ recovered: true });
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('retries an AbortError the caller did not cause as a transport failure', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'))
            .mockResolvedValueOnce(jsonResponse({ recovered: true }));
        const client = makeClient(fetchFn, { retry: { attempts: 2, backoff: fixedBackoff(10) } });

        const pending = client.get<RecoveredBody>('/items');

        await vi.advanceTimersByTimeAsync(10);

        await expect(pending).resolves.toStrictEqual({ recovered: true });
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('stops without notifying when the caller aborts a retried attempt', async () => {
        const caller = new AbortController();
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValueOnce(jsonResponse({}, 503))
            .mockImplementationOnce(() => {
                caller.abort();

                return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, {
            retry: { attempts: 2, backoff: fixedBackoff(10) },
            onResponseError,
        });

        const pending = rejectionOf(client.get('/items', { signal: caller.signal }), CancelledError);

        await vi.advanceTimersByTimeAsync(10);

        await pending;
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(onResponseError).not.toHaveBeenCalled();
    });
});

describe('FetchHttpClient - transient retry with 401 handling', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('re-runs the interceptors so a retry carries a token rotated during the backoff', async () => {
        let token = 'old';
        const fetchFn = statusSequence([503, 200]);
        const client = makeClient(fetchFn, {
            retry: { attempts: 1, backoff: fixedBackoff(10) },
            requestInterceptors: [createBearerTokenInterceptor({ getAccessToken: () => token })],
        });

        const pending = client.get('/items');

        setTimeout(() => {
            token = 'new';
        }, 5);
        await vi.advanceTimersByTimeAsync(10);

        await expect(pending).resolves.toStrictEqual({ recovered: true });
        expect(fetchFn.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))).toStrictEqual([
            'Bearer old',
            'Bearer new',
        ]);
    });

    /**
     * Build a retrying client whose bearer token advances with each handler
     * invocation.
     *
     * @param refreshes - what the handler resolves with
     */
    function rotatingClient(fetchFn: typeof fetch, refreshes: boolean): RotatingClient {
        let revision = 0;
        const onUnauthorized = vi.fn<UnauthorizedHandler>(() => {
            revision += 1;

            return Promise.resolve(refreshes);
        });
        const onResponseError = vi.fn<ResponseErrorHandler>();
        const client = makeClient(fetchFn, {
            retry: { attempts: 2, backoff: fixedBackoff(10) },
            requestInterceptors: [createBearerTokenInterceptor({ getAccessToken: () => `A${String(revision)}` })],
            onUnauthorized,
            onResponseError,
        });

        return { client, onUnauthorized, onResponseError };
    }

    it.each([
        ['503, 401, 200', [503, 401, 200]],
        ['401, 503, 200', [401, 503, 200]],
    ])('resolves %s with one handler invocation', async (_case, statuses) => {
        const fetchFn = statusSequence(statuses);
        const { client, onUnauthorized, onResponseError } = rotatingClient(fetchFn, true);

        const pending = client.get('/items');

        await vi.advanceTimersByTimeAsync(100);

        await expect(pending).resolves.toStrictEqual({ recovered: true });
        expect(fetchFn).toHaveBeenCalledTimes(3);
        expect(onUnauthorized).toHaveBeenCalledOnce();
        expect(onResponseError).not.toHaveBeenCalled();
    });

    it.each([
        ['401, 503, 401', [401, 503, 401], true, 'Bearer A1'],
        ['401, 503, 503, 401', [401, 503, 503, 401], true, 'Bearer A1'],
        ['a refused 401', [401], false, 'Bearer A0'],
    ])('rejects %s with the 401 after one handler invocation', async (_case, statuses, refreshes, authorization) => {
        const fetchFn = statusSequence(statuses);
        const { client, onUnauthorized, onResponseError } = rotatingClient(fetchFn, refreshes);

        const pending = rejectionOf(client.get('/items'), HttpError);

        await vi.advanceTimersByTimeAsync(100);

        const error = await pending;

        expect(error.status).toBe(401);
        expect(fetchFn).toHaveBeenCalledTimes(statuses.length);
        expect(onUnauthorized).toHaveBeenCalledOnce();
        expect(onResponseError).toHaveBeenCalledExactlyOnceWith(error, expect.anything());
        expect(onResponseError.mock.calls[0]?.[1].headers['authorization']).toBe(authorization);
    });

    it('keeps the single handler invocation across transient retries of a download', async () => {
        const fetchFn = statusSequence([401, 503, 503, 401]);
        const onUnauthorized = vi.fn<UnauthorizedHandler>().mockResolvedValue(true);
        const onResponseError = vi.fn<ResponseErrorHandler>();
        const client = makeClient(fetchFn, {
            retry: { attempts: 2, backoff: fixedBackoff(10) },
            onUnauthorized,
            onResponseError,
        });

        const pending = rejectionOf(client.download('/files/1'), HttpError);

        await vi.advanceTimersByTimeAsync(100);

        const error = await pending;

        expect(error.status).toBe(401);
        expect(fetchFn).toHaveBeenCalledTimes(4);
        expect(onUnauthorized).toHaveBeenCalledOnce();
        expect(onResponseError).toHaveBeenCalledExactlyOnceWith(error, expect.objectContaining({ method: 'GET' }));
    });
});
