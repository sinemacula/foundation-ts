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

/** A constructor of the error type a rejection is expected to have. */
type ErrorType<E extends Error> = new (...args: never[]) => E;

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
 * Read the signal handed to the most recent fetch call.
 *
 * @param fn - the fetch stub
 * @returns the signal, or null/undefined when none was passed
 */
function lastSignal(fn: FetchStub): AbortSignal | null | undefined {
    return fn.mock.calls.at(-1)?.[1]?.signal;
}

/**
 * A fetch implementation that mimics real fetch's abort behaviour: it rejects
 * with the signal's reason as soon as its signal aborts, and otherwise never
 * settles.
 *
 * @param _input - the request URL, unused
 * @param init - the request init carrying the signal
 * @returns a response promise that only ever rejects
 */
function hangUntilAborted(_input: FetchArgs[0], init?: RequestInit): Promise<Response> {
    const signal = init?.signal;

    return new Promise<Response>((_resolve, reject) => {
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
    });
}

/**
 * A fetch implementation that ignores its signal and fails as a dropped
 * connection after a delay.
 *
 * @returns a response promise that rejects after ten seconds
 */
function failAfterTenSeconds(): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
        setTimeout(() => {
            reject(new TypeError('Failed to fetch'));
        }, 10_000);
    });
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
        const fetchFn = makeFetch(hangUntilAborted);
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, { timeout: 5_000, onResponseError });

        const pending = rejectionOf(client.get('/items?token=secret'), TimeoutError);

        await vi.advanceTimersByTimeAsync(4_999);
        expect(lastSignal(fetchFn)?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);

        const error = await pending;

        expect(error).toBeInstanceOf(NetworkError);
        expect(error.name).toBe('TimeoutError');
        expect(error.message).toBe('GET https://api.example.com/items timed out after 5000ms.');
        expect(error.cause).toBe(lastSignal(fetchFn)?.reason);
        expect(onResponseError).toHaveBeenCalledWith(error, expect.objectContaining({ method: 'GET' }));
    });

    it('still times out when the runtime lacks AbortSignal.timeout and AbortSignal.any', async () => {
        const originalTimeout = AbortSignal.timeout;
        const originalAny = AbortSignal.any;
        const mutable = AbortSignal as unknown as Record<'timeout' | 'any', unknown>;

        mutable.timeout = undefined;
        mutable.any = undefined;

        try {
            const client = makeClient(makeFetch(hangUntilAborted), { timeout: 1_000 });
            const caller = new AbortController();

            const pending = rejectionOf(client.get('/items', { signal: caller.signal }), TimeoutError);

            await vi.advanceTimersByTimeAsync(1_000);

            await pending;
            expect(caller.signal.aborted).toBe(false);
        } finally {
            mutable.timeout = originalTimeout;
            mutable.any = originalAny;
        }
    });

    it('rejects with a CancelledError carrying the caller reason when the caller aborts first', async () => {
        const onResponseError = vi.fn();
        const client = makeClient(makeFetch(hangUntilAborted), { timeout: 5_000, onResponseError });
        const caller = new AbortController();
        const reason = new Error('navigated away');

        const pending = rejectionOf(client.get('/items', { signal: caller.signal }), CancelledError);

        await vi.advanceTimersByTimeAsync(10);
        caller.abort(reason);

        expect((await pending).cause).toBe(reason);
        expect(onResponseError).not.toHaveBeenCalled();
    });

    it('rejects with a CancelledError when the caller signal had already aborted', async () => {
        const fetchFn = makeFetch(hangUntilAborted);
        const client = makeClient(fetchFn, { timeout: 5_000 });

        await rejectionOf(client.get('/items', { signal: AbortSignal.abort() }), CancelledError);

        expect(lastSignal(fetchFn)?.aborted).toBe(true);
    });

    it('keeps a caller abort a CancelledError when the timeout elapses before fetch settles', async () => {
        const client = makeClient(makeFetch(failAfterTenSeconds), { timeout: 5_000 });
        const caller = new AbortController();

        const pending = rejectionOf(client.get('/items', { signal: caller.signal }), CancelledError);

        await vi.advanceTimersByTimeAsync(1_000);
        caller.abort();
        await vi.advanceTimersByTimeAsync(9_000);

        await pending;
    });

    it('keeps a timeout a TimeoutError when the caller aborts before fetch settles', async () => {
        const client = makeClient(makeFetch(failAfterTenSeconds), { timeout: 5_000 });
        const caller = new AbortController();

        const pending = rejectionOf(client.get('/items', { signal: caller.signal }), TimeoutError);

        await vi.advanceTimersByTimeAsync(6_000);
        caller.abort();
        await vi.advanceTimersByTimeAsync(4_000);

        await pending;
    });

    it('maps an AbortError that neither the timeout nor the caller caused to a NetworkError', async () => {
        const cause = new DOMException('The operation was aborted.', 'AbortError');
        const client = makeClient(
            makeFetch(() => Promise.reject(cause)),
            { timeout: 5_000 },
        );

        const error = await rejectionOf(client.get('/items', { signal: new AbortController().signal }), NetworkError);

        expect(error).not.toBeInstanceOf(TimeoutError);
        expect(error.cause).toBe(cause);
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
        const client = makeClient(makeHangingBodyFetch(), { timeout: 5_000 });

        const pending = rejectionOf(client.get('/items'), TimeoutError);

        await vi.advanceTimersByTimeAsync(5_000);

        await pending;
    });

    it('rejects with a CancelledError when the caller aborts while the body is read', async () => {
        const client = makeClient(makeHangingBodyFetch(), { timeout: 5_000 });
        const caller = new AbortController();

        const pending = rejectionOf(client.download('/files/1', { signal: caller.signal }), CancelledError);

        await vi.advanceTimersByTimeAsync(10);
        caller.abort();

        await pending;
    });

    it('retries a timed-out GET under the retry policy', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValueOnce(jsonResponse({}, 503))
            .mockImplementationOnce(hangUntilAborted)
            .mockResolvedValueOnce(jsonResponse({ recovered: true }));
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
        const client = makeClient(makeFetch(async () => resetBodyResponse()));

        const error = await rejectionOf(client.get('/items?page=2#top'), NetworkError);

        expect(error).not.toBeInstanceOf(TimeoutError);
        expect(error.message).toBe('GET https://api.example.com/items failed while reading the response body.');
        expect(error.cause).toBeInstanceOf(TypeError);
    });

    it('maps a connection reset while reading a download to a NetworkError', async () => {
        const client = makeClient(makeFetch(async () => resetBodyResponse()));

        await expect(client.download('/files/1')).rejects.toBeInstanceOf(NetworkError);
    });

    it('maps a connection reset while reading an error body to a NetworkError', async () => {
        const client = makeClient(makeFetch(async () => resetBodyResponse(500)));

        const error = await rejectionOf(client.get('/items'), NetworkError);

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

        const error = await rejectionOf(client.get('/items?token=secret'), ResponseParseError);

        expect(error.status).toBe(200);
        expect(error.message).toBe('GET https://api.example.com/items returned a JSON body that could not be parsed.');
        expect(error.cause).toBeInstanceOf(SyntaxError);
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

        const pending = rejectionOf(client.get('/items?token=secret', { signal: caller.signal }), CancelledError);

        await vi.advanceTimersByTimeAsync(100);
        caller.abort(reason);

        const error = await pending;

        expect(error.message).toBe('GET https://api.example.com/items was cancelled before its retry.');
        expect(error.cause).toBe(reason);
        expect(vi.getTimerCount()).toBe(0);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(onResponseError).not.toHaveBeenCalled();
    });

    it('names the redacted request URL when an interceptor failed before the request resolved', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const caller = new AbortController();
        const client = makeClient(fetchFn, {
            retry: { attempts: 2, backoff: { delayFor: (): number => 10_000 } },
            requestInterceptors: [
                () => {
                    throw new NetworkError('token refresh failed');
                },
            ],
        });

        const pending = rejectionOf(
            client.get('/reset?token=secret', { query: { page: 2 }, signal: caller.signal }),
            CancelledError,
        );

        await vi.advanceTimersByTimeAsync(100);
        caller.abort();

        expect((await pending).message).toBe('GET https://api.example.com/reset was cancelled before its retry.');
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('skips the backoff entirely when the caller signal aborted during the failed attempt', async () => {
        const caller = new AbortController();
        const fetchFn = makeFetch(() => {
            caller.abort();

            return Promise.resolve(jsonResponse({}, 503));
        });
        const client = makeClient(fetchFn, { retry: { attempts: 2, backoff: { delayFor: (): number => 10_000 } } });

        await rejectionOf(client.get('/items', { signal: caller.signal }), CancelledError);

        expect(vi.getTimerCount()).toBe(0);
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('detaches from the caller signal once the backoff elapses', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValueOnce(jsonResponse({}, 503))
            .mockResolvedValueOnce(jsonResponse({ recovered: true }));
        const client = makeClient(fetchFn, { retry: { attempts: 2, backoff: { delayFor: (): number => 100 } } });
        const caller = new AbortController();
        const removeListener = vi.spyOn(caller.signal, 'removeEventListener');

        const pending = client.get('/items', { signal: caller.signal });

        await vi.advanceTimersByTimeAsync(100);

        await expect(pending).resolves.toStrictEqual({ recovered: true });
        expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    });
});
