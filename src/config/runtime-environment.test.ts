/**
 * Unit tests for runtime-environment.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchRuntimeEnvironment } from './runtime-environment';
import { RuntimeEnvironmentError } from './runtime-environment-error';

const URL = '/runtime-env.json';

/**
 * Build a `Record<string, T>` from an array of `[key, value]` pairs.
 *
 * Keeps non-camelCase environment keys out of object-literal key positions so
 * naming-convention lint rules never see them.
 *
 * @param entries - key-value pairs for the record
 * @returns a plain `Record<string, T>`
 */
function wire<T>(entries: ReadonlyArray<readonly [string, T]>): Record<string, T> {
    return Object.fromEntries(entries);
}

/**
 * Build a JSON response.
 *
 * @param payload - the body to serialise
 * @param status - the HTTP status code
 * @returns the response
 */
function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

/**
 * Build a fetch stub resolving the given response.
 *
 * @param response - the response to resolve
 * @returns the stub
 */
function respondWith(response: Response): typeof fetch {
    return vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

/**
 * Build a fetch stub that never settles.
 *
 * @returns the stub
 */
function hangingFetch(): typeof fetch {
    return vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
}

/**
 * Capture the rejection of a load.
 *
 * @param load - the pending load
 * @returns the rejection reason
 */
function rejectionOf(load: Promise<unknown>): Promise<unknown> {
    return load.then(
        () => {
            throw new Error('expected the load to reject');
        },
        (error: unknown) => error,
    );
}

describe('fetchRuntimeEnvironment', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('returns only string-valued entries from a successful response', async () => {
        const fetchFn = respondWith(
            jsonResponse(
                wire<string | number | boolean>([
                    ['API_URL', 'https://api.example.com'],
                    ['COUNT', 42],
                    ['FLAG', true],
                ]),
            ),
        );

        await expect(fetchRuntimeEnvironment({ url: URL }, fetchFn)).resolves.toStrictEqual(
            wire([['API_URL', 'https://api.example.com']]),
        );
    });

    it('returns an empty record when the document does not exist, even when its body parses', async () => {
        const fetchFn = respondWith(jsonResponse(wire([['API_URL', 'https://stale.example.com']]), 404));

        await expect(fetchRuntimeEnvironment({ url: URL }, fetchFn)).resolves.toStrictEqual({});
    });

    it('requests the given url uncached, accepting JSON, under an abort signal', async () => {
        const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}));

        await fetchRuntimeEnvironment({ url: '/custom/runtime-env.json' }, fetchFn as unknown as typeof fetch);

        expect(fetchFn).toHaveBeenCalledWith('/custom/runtime-env.json', {
            cache: 'no-store',
            headers: { accept: 'application/json' },
            signal: expect.any(AbortSignal),
        });
    });

    it('uses the global fetch when none is provided', async () => {
        vi.stubGlobal('fetch', respondWith(jsonResponse(wire([['RUNTIME', 'yes']]))));

        await expect(fetchRuntimeEnvironment({ url: URL })).resolves.toStrictEqual(wire([['RUNTIME', 'yes']]));
    });

    it('rejects with the transport failure as the cause when the request fails', async () => {
        const failure = new TypeError('network error');
        const fetchFn = vi.fn().mockRejectedValue(failure) as unknown as typeof fetch;

        const error = await rejectionOf(fetchRuntimeEnvironment({ url: URL }, fetchFn));

        expect(error).toBeInstanceOf(RuntimeEnvironmentError);
        expect(error).toHaveProperty('message', 'The runtime environment document could not be fetched.');
        expect(error).toHaveProperty('cause', failure);
    });

    it.each([403, 500, 503])('rejects when the document responds with %i', async status => {
        const fetchFn = respondWith(jsonResponse({}, status));

        await expect(fetchRuntimeEnvironment({ url: URL }, fetchFn)).rejects.toThrow(
            new RuntimeEnvironmentError(`The runtime environment document responded with ${status}.`),
        );
    });

    it('rejects with the parse failure as the cause when the body is not JSON', async () => {
        const fetchFn = respondWith(new Response('<html>', { status: 200 }));

        const error = await rejectionOf(fetchRuntimeEnvironment({ url: URL }, fetchFn));

        expect(error).toBeInstanceOf(RuntimeEnvironmentError);
        expect(error).toHaveProperty('message', 'The runtime environment document is not valid JSON.');
        expect(error).toHaveProperty('cause', expect.any(SyntaxError));
    });

    it.each([
        ['null', null],
        ['an array', ['a', 'b']],
        ['a string', 'just a string'],
        ['a number', 123],
    ])('rejects when the payload is %s', async (_, payload) => {
        const fetchFn = respondWith(jsonResponse(payload));

        await expect(fetchRuntimeEnvironment({ url: URL }, fetchFn)).rejects.toThrow(
            new RuntimeEnvironmentError('The runtime environment document must be a JSON object.'),
        );
    });

    it('rejects and aborts the request once the default five-second deadline passes', async () => {
        vi.useFakeTimers();

        const fetchFn = vi.fn(() => new Promise<Response>(() => undefined));
        const load = rejectionOf(fetchRuntimeEnvironment({ url: URL }, fetchFn as unknown as typeof fetch));

        await vi.advanceTimersByTimeAsync(4999);

        const signal = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].signal;

        expect(signal?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);

        await expect(load).resolves.toStrictEqual(
            new RuntimeEnvironmentError('The runtime environment document did not load within 5000 ms.'),
        );
        expect(signal?.aborted).toBe(true);
    });

    it('holds the body read to the same deadline as the request', async () => {
        vi.useFakeTimers();

        const stalled = new Response('{}', { status: 200 });

        vi.spyOn(stalled, 'json').mockReturnValue(new Promise(() => undefined));

        const load = rejectionOf(fetchRuntimeEnvironment({ url: URL, timeout: 250 }, respondWith(stalled)));

        await vi.advanceTimersByTimeAsync(250);

        await expect(load).resolves.toStrictEqual(
            new RuntimeEnvironmentError('The runtime environment document did not load within 250 ms.'),
        );
    });

    it('settles at the deadline even when the fetch ignores the abort signal', async () => {
        vi.useFakeTimers();

        const load = rejectionOf(fetchRuntimeEnvironment({ url: URL, timeout: 100 }, hangingFetch()));

        await vi.advanceTimersByTimeAsync(100);

        await expect(load).resolves.toBeInstanceOf(RuntimeEnvironmentError);
    });

    it('clears the deadline once the document loads', async () => {
        vi.useFakeTimers();

        await fetchRuntimeEnvironment({ url: URL }, respondWith(jsonResponse({})));

        expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the deadline when the load fails', async () => {
        vi.useFakeTimers();

        await fetchRuntimeEnvironment({ url: URL }, respondWith(jsonResponse({}, 500))).catch(() => undefined);

        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
        'rejects a timeout of %d without requesting the document',
        async timeout => {
            const fetchFn = hangingFetch();

            await expect(fetchRuntimeEnvironment({ url: URL, timeout }, fetchFn)).rejects.toThrow(
                new RangeError('The runtime environment timeout must be between 1 and 2147483647 ms.'),
            );
            expect(fetchFn).not.toHaveBeenCalled();
        },
    );

    it('accepts the longest timer delay', async () => {
        const fetchFn = respondWith(jsonResponse({}));

        await expect(fetchRuntimeEnvironment({ url: URL, timeout: 2_147_483_647 }, fetchFn)).resolves.toStrictEqual({});
    });
});
