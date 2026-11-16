/**
 * Unit tests for FetchHttpClient - abort signals, the request timeout, body
 * read failures, and cancellation during a retry backoff.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FetchHttpClient } from './fetch-http-client';
import { CancelledError, HttpError, NetworkError, ResponseParseError, TimeoutError } from './http-error';

/** Explicit overload signature so mock.calls carries a typed tuple, not []. */
type FetchArgs = [input: Request | string | URL, init?: RequestInit];

/** A typed fetch stub. */
type FetchStub = ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>>;

/**
 * Build a JSON response.
 *
 * @param body - the value to serialise
 * @param status - the response status
 * @returns the response
 */
function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Build a JSON-typed response whose body stream is driven by a start hook.
 *
 * @param start - receives the stream controller when the stream starts
 * @param status - the response status
 * @returns the response
 */
function streamedResponse(
    start: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
    status = 200,
): Response {
    return new Response(new ReadableStream<Uint8Array>({ start }), {
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
function makeFetch(impl: (...args: FetchArgs) => Promise<Response>): FetchStub {
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
 * Read the signal handed to the most recent fetch call.
 *
 * @param fn - the fetch stub
 * @returns the signal, or null/undefined when none was passed
 */
function lastSignal(fn: FetchStub): AbortSignal | null | undefined {
    return fn.mock.calls.at(-1)?.[1]?.signal;
}

/**
 * A fetch stub that mimics real fetch's abort behaviour: it rejects with the
 * signal's reason as soon as its signal aborts, and otherwise never settles.
 *
 * @returns the fetch stub
 */
function makeAbortAwareFetch(): FetchStub {
    return makeFetch(
        (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;

                if (signal === undefined || signal === null) {
                    return;
                }

                if (signal.aborted) {
                    reject(signal.reason);

                    return;
                }

                signal.addEventListener('abort', () => {
                    reject(signal.reason);
                });
            }),
    );
}

/**
 * A fetch stub whose response arrives at once but whose body only ends by
 * erroring with the signal's reason once the signal aborts.
 *
 * @returns the fetch stub
 */
function makeHangingBodyFetch(): FetchStub {
    return makeFetch(async (_input, init) =>
        streamedResponse(controller => {
            init?.signal?.addEventListener('abort', () => {
                controller.error(init.signal?.reason);
            });
        }),
    );
}

/**
 * A response whose body stream fails partway, as on a connection reset.
 *
 * @param status - the response status
 * @returns the response
 */
function resetBodyResponse(status = 200): Response {
    return streamedResponse(controller => {
        controller.error(new TypeError('terminated'));
    }, status);
}

describe('FetchHttpClient - abort signal resolution', () => {
    it('passes the caller signal through untouched when no timeout is configured', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn);
        const controller = new AbortController();

        await client.get('/items', { signal: controller.signal });

        expect(lastSignal(fetchFn)).toBe(controller.signal);
    });

    it('passes a null signal when neither a timeout nor a caller signal applies', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn);

        await client.get('/items');

        expect(lastSignal(fetchFn)).toBeNull();
    });

    it.each([0, -1])('treats a timeout of %d as no timeout', async timeout => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn, { timeout });

        await client.get('/items');

        expect(lastSignal(fetchFn)).toBeNull();
    });

    it('passes a live signal of its own when a timeout is configured', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn, { timeout: 5_000 });
        const controller = new AbortController();

        await client.get('/items', { signal: controller.signal });

        const signal = lastSignal(fetchFn);

        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal).not.toBe(controller.signal);
        expect(signal?.aborted).toBe(false);
    });
});

describe('FetchHttpClient - request timeout', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('rejects with a TimeoutError, a NetworkError subtype, once the timeout elapses', async () => {
        const fetchFn = makeAbortAwareFetch();
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { timeout: 5_000, onResponseError });

        const pending = client.get('/items?token=secret').catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(4_999);
        expect(lastSignal(fetchFn)?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);

        const error = await pending;

        expect(error).toBeInstanceOf(TimeoutError);
        expect(error).toBeInstanceOf(NetworkError);
        expect(error).not.toBeInstanceOf(CancelledError);
        // Cast proven safe: toBeInstanceOf(TimeoutError) guards the type.
        expect((error as TimeoutError).name).toBe('TimeoutError');
        expect((error as TimeoutError).message).toBe('GET https://api.example.com/items timed out after 5000ms.');
        expect((error as TimeoutError).cause).toBe(lastSignal(fetchFn)?.reason);
        expect(onResponseError).toHaveBeenCalledWith(error, expect.objectContaining({ method: 'GET' }));
    });

    it('still times out when the runtime lacks AbortSignal.timeout and AbortSignal.any', async () => {
        const originalTimeout = AbortSignal.timeout;
        const originalAny = AbortSignal.any;
        const mutable = AbortSignal as unknown as Record<'timeout' | 'any', unknown>;

        mutable.timeout = undefined;
        mutable.any = undefined;

        try {
            const fetchFn = makeAbortAwareFetch();
            const client = makeClient(fetchFn, { timeout: 1_000 });
            const caller = new AbortController();

            const pending = client.get('/items', { signal: caller.signal }).catch((error: unknown) => error);

            await vi.advanceTimersByTimeAsync(1_000);

            expect(await pending).toBeInstanceOf(TimeoutError);
            expect(caller.signal.aborted).toBe(false);
        } finally {
            mutable.timeout = originalTimeout;
            mutable.any = originalAny;
        }
    });

    it('rejects with a CancelledError carrying the caller reason when the caller aborts first', async () => {
        const fetchFn = makeAbortAwareFetch();
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { timeout: 5_000, onResponseError });
        const caller = new AbortController();
        const reason = new Error('navigated away');

        const pending = client.get('/items', { signal: caller.signal }).catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(10);
        caller.abort(reason);

        const error = await pending;

        expect(error).toBeInstanceOf(CancelledError);
        // Cast proven safe: toBeInstanceOf(CancelledError) guards the type.
        expect((error as CancelledError).cause).toBe(reason);
        expect(onResponseError).not.toHaveBeenCalled();
    });

    it('rejects with a CancelledError when the caller signal had already aborted', async () => {
        const fetchFn = makeAbortAwareFetch();
        const client = makeClient(fetchFn, { timeout: 5_000 });

        const error = await client.get('/items', { signal: AbortSignal.abort() }).catch((error: unknown) => error);

        expect(error).toBeInstanceOf(CancelledError);
        expect(lastSignal(fetchFn)?.aborted).toBe(true);
    });

    it('keeps a caller abort a CancelledError when the timeout elapses before fetch settles', async () => {
        const fetchFn = makeFetch(
            () =>
                new Promise<Response>((_resolve, reject) => {
                    setTimeout(() => {
                        reject(new TypeError('Failed to fetch'));
                    }, 10_000);
                }),
        );
        const client = makeClient(fetchFn, { timeout: 5_000 });
        const caller = new AbortController();

        const pending = client.get('/items', { signal: caller.signal }).catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(1_000);
        caller.abort();
        await vi.advanceTimersByTimeAsync(9_000);

        expect(await pending).toBeInstanceOf(CancelledError);
    });

    it('clears the timer and detaches from the caller signal once the body is read', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ ok: true }));
        const client = makeClient(fetchFn, { timeout: 5_000 });
        const caller = new AbortController();

        await expect(client.get('/items', { signal: caller.signal })).resolves.toStrictEqual({ ok: true });

        expect(vi.getTimerCount()).toBe(0);

        caller.abort();

        expect(lastSignal(fetchFn)?.aborted).toBe(false);
    });

    it('covers the body read, rejecting with a TimeoutError when the body stalls', async () => {
        const fetchFn = makeHangingBodyFetch();
        const client = makeClient(fetchFn, { timeout: 5_000 });

        const pending = client.get('/items').catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(5_000);

        expect(await pending).toBeInstanceOf(TimeoutError);
    });

    it('rejects with a CancelledError when the caller aborts while the body is read', async () => {
        const fetchFn = makeHangingBodyFetch();
        const client = makeClient(fetchFn, { timeout: 5_000 });
        const caller = new AbortController();

        const pending = client.download('/files/1', { signal: caller.signal }).catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(10);
        caller.abort();

        expect(await pending).toBeInstanceOf(CancelledError);
    });

    it('retries a timed-out GET under the retry policy', async () => {
        const fetchFn = makeAbortAwareFetch().mockImplementationOnce(async () => jsonResponse({}, 503));
        fetchFn.mockImplementationOnce(
            (_input, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        reject(init.signal?.reason);
                    });
                }),
        );
        fetchFn.mockImplementationOnce(async () => jsonResponse({ recovered: true }));
        const backoff = { delayFor: (): number => 100 };
        const client = makeClient(fetchFn, { timeout: 1_000, retry: { attempts: 2, backoff } });

        const pending = client.get('/items');

        await vi.advanceTimersByTimeAsync(100 + 1_000 + 100);

        await expect(pending).resolves.toStrictEqual({ recovered: true });
        expect(fetchFn).toHaveBeenCalledTimes(3);
    });
});

describe('FetchHttpClient - body read failures', () => {
    it('maps a connection reset mid-body to a NetworkError', async () => {
        const fetchFn = makeFetch(async () => resetBodyResponse());
        const client = makeClient(fetchFn);

        const error = await client.get('/items?page=2#top').catch((error: unknown) => error);

        expect(error).toBeInstanceOf(NetworkError);
        expect(error).not.toBeInstanceOf(TimeoutError);
        // Cast proven safe: toBeInstanceOf(NetworkError) guards the type.
        expect((error as NetworkError).message).toBe(
            'GET https://api.example.com/items failed while reading the response body.',
        );
        expect((error as NetworkError).cause).toBeInstanceOf(TypeError);
    });

    it('maps a connection reset while reading a download to a NetworkError', async () => {
        const fetchFn = makeFetch(async () => resetBodyResponse());
        const client = makeClient(fetchFn);

        await expect(client.download('/files/1')).rejects.toBeInstanceOf(NetworkError);
    });

    it('maps a connection reset while reading an error body to a NetworkError', async () => {
        const fetchFn = makeFetch(async () => resetBodyResponse(500));
        const client = makeClient(fetchFn);

        const error = await client.get('/items').catch((error: unknown) => error);

        expect(error).toBeInstanceOf(NetworkError);
        expect(error).not.toBeInstanceOf(HttpError);
    });

    it('maps an unparseable JSON success body to a reported ResponseParseError', async () => {
        const fetchFn = makeFetch(
            async () =>
                new Response('<html>maintenance</html>', {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { onResponseError, retry: { attempts: 2 } });

        const error = await client.get('/items?token=secret').catch((error: unknown) => error);

        expect(error).toBeInstanceOf(ResponseParseError);
        // Cast proven safe: toBeInstanceOf(ResponseParseError) guards the type.
        expect((error as ResponseParseError).status).toBe(200);
        expect((error as ResponseParseError).message).toBe(
            'GET https://api.example.com/items returned a JSON body that could not be parsed.',
        );
        expect((error as ResponseParseError).cause).toBeInstanceOf(SyntaxError);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(onResponseError).toHaveBeenCalledWith(error, expect.objectContaining({ method: 'GET' }));
    });
});

describe('FetchHttpClient - cancellation during retry backoff', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('stops waiting and rejects with a CancelledError when the caller aborts during the backoff', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}, 503));
        const onResponseError = vi.fn();
        const backoff = { delayFor: (): number => 10_000 };
        const client = makeClient(fetchFn, { retry: { attempts: 2, backoff }, onResponseError });
        const caller = new AbortController();
        const reason = new Error('left the page');

        const pending = client.get('/items', { signal: caller.signal }).catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(100);
        caller.abort(reason);

        const error = await pending;

        expect(error).toBeInstanceOf(CancelledError);
        // Cast proven safe: toBeInstanceOf(CancelledError) guards the type.
        expect((error as CancelledError).message).toBe('GET /items was cancelled before its retry.');
        expect((error as CancelledError).cause).toBe(reason);
        expect(vi.getTimerCount()).toBe(0);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(onResponseError).not.toHaveBeenCalled();
    });

    it('skips the backoff entirely when the caller signal aborted during the failed attempt', async () => {
        const caller = new AbortController();
        const fetchFn = makeFetch(() => {
            caller.abort();

            return Promise.resolve(jsonResponse({}, 503));
        });
        const client = makeClient(fetchFn, { retry: { attempts: 2, backoff: { delayFor: (): number => 10_000 } } });

        const error = await client.get('/items', { signal: caller.signal }).catch((error: unknown) => error);

        expect(error).toBeInstanceOf(CancelledError);
        expect(vi.getTimerCount()).toBe(0);
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('detaches from the caller signal once the backoff elapses', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}, 503));
        fetchFn.mockImplementationOnce(async () => jsonResponse({}, 503));
        fetchFn.mockImplementationOnce(async () => jsonResponse({ recovered: true }));
        const client = makeClient(fetchFn, { retry: { attempts: 2, backoff: { delayFor: (): number => 100 } } });
        const caller = new AbortController();
        const removeListener = vi.spyOn(caller.signal, 'removeEventListener');

        const pending = client.get('/items', { signal: caller.signal });

        await vi.advanceTimersByTimeAsync(100);

        await expect(pending).resolves.toStrictEqual({ recovered: true });
        expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    });
});
