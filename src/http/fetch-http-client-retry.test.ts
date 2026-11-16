/**
 * Unit tests for FetchHttpClient - opt-in transient retry policy.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExponentialBackoff } from '../realtime/exponential-backoff';
import { FetchHttpClient } from './fetch-http-client';
import { CancelledError, HttpError, MaintenanceError } from './http-error';

/** The body a recovered retry resolves with. */
interface RecoveredBody {
    /** Whether the retry recovered. */
    readonly recovered: boolean;
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

/** Fixed-delay backoff for deterministic retry-delay assertions. */
function fixedBackoff(delay: number): ExponentialBackoff {
    return new ExponentialBackoff({ initialDelay: delay, multiplier: 1, maxDelay: delay });
}

describe('FetchHttpClient - transient retry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('recovers after one 503, awaiting the backoff delay before the next attempt', async () => {
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

    it('recovers after a NetworkError then succeeds', async () => {
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

    it('uses the default retry attempts and backoff when retry is enabled without options', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValueOnce(jsonResponse({}, 503))
            .mockResolvedValueOnce(jsonResponse({}, 503))
            .mockResolvedValueOnce(jsonResponse({ recovered: true }));
        const client = makeClient(fetchFn, { retry: {} });

        const pending = client.get<RecoveredBody>('/items');

        // Default ExponentialBackoff: 1 000 ms then 2 000 ms.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fetchFn).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(fetchFn).toHaveBeenCalledTimes(3);

        await expect(pending).resolves.toStrictEqual({ recovered: true });
    });

    it('exhausts the retry budget then throws the final error with one notification', async () => {
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

    it('accepts any structural backoff exposing delayFor', async () => {
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

    it('stops immediately when a CancelledError occurs mid-retry, without a further attempt or notification', async () => {
        const fetchFn = vi
            .fn<(...args: FetchArgs) => Promise<Response>>()
            .mockResolvedValueOnce(jsonResponse({}, 503))
            .mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, {
            retry: { attempts: 2, backoff: fixedBackoff(10) },
            onResponseError,
        });

        const pending = rejectionOf(client.get('/items'), CancelledError);

        await vi.advanceTimersByTimeAsync(10);

        await pending;
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(onResponseError).not.toHaveBeenCalled();
    });
});
