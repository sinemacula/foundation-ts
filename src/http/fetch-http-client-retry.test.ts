/**
 * Unit tests for FetchHttpClient - opt-in transient retry policy.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExponentialBackoff } from '../realtime/exponential-backoff';
import { FetchHttpClient } from './fetch-http-client';
import { CancelledError, HttpError } from './http-error';

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

function makeClient(
    fetchFn: typeof fetch,
    extra: Partial<ConstructorParameters<typeof FetchHttpClient>[0]> = {},
): FetchHttpClient {
    return new FetchHttpClient({ baseUrl: 'https://api.example.com', fetchFn, ...extra });
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

        const pending = client.get<{ recovered: boolean }>('/items');

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

        const pending = client.get<{ recovered: boolean }>('/items');

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

        const pending = client.get<{ recovered: boolean }>('/items');

        // Default ExponentialBackoff: 1 000 ms then 2 000 ms.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fetchFn).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(fetchFn).toHaveBeenCalledTimes(3);

        await expect(pending).resolves.toStrictEqual({ recovered: true });
    });

    it('exhausts the retry budget then throws the final error with one notification', async () => {
        const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>().mockResolvedValue(jsonResponse({}, 503));
        const onResponseError = vi.fn();
        const client = makeClient(fetchFn, {
            retry: { attempts: 1, backoff: fixedBackoff(10) },
            onResponseError,
        });

        const pending = client.get('/items').catch(error => error);

        await vi.advanceTimersByTimeAsync(10);

        const error = await pending;

        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).status).toBe(503);
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(onResponseError).toHaveBeenCalledTimes(1);
        expect(onResponseError).toHaveBeenCalledWith(error, expect.objectContaining({ method: 'GET' }));
    });

    it('does not retry a POST even when retry is configured', async () => {
        const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>().mockResolvedValue(jsonResponse({}, 503));
        const client = makeClient(fetchFn, { retry: { attempts: 2, backoff: fixedBackoff(10) } });

        await expect(client.post('/items', {})).rejects.toBeInstanceOf(HttpError);

        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('does not retry a 500 status', async () => {
        const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>().mockResolvedValue(jsonResponse({}, 500));
        const client = makeClient(fetchFn, { retry: { attempts: 2, backoff: fixedBackoff(10) } });

        await expect(client.get('/items')).rejects.toBeInstanceOf(HttpError);

        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('does not retry a transient status when no retry policy is configured', async () => {
        const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>().mockResolvedValue(jsonResponse({}, 503));
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

        const pending = client.get('/items').catch(error => error);

        await vi.advanceTimersByTimeAsync(10);

        const error = await pending;

        expect(error).toBeInstanceOf(CancelledError);
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(onResponseError).not.toHaveBeenCalled();
    });
});
