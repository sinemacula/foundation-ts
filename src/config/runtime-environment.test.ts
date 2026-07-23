/**
 * Unit tests for runtime-environment.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchRuntimeEnvironment } from './runtime-environment';

const URL = '/runtime-env.json';

/**
 * Build a `Record<string, T>` from an array of `[key, value]` pairs.
 *
 * Wraps `Object.fromEntries` so callers can write wire-field names as plain
 * string literals inside array elements rather than as object-literal keys -
 * keeping non-camelCase environment keys out of any position that Biome's
 * naming-convention or literal-keys rules inspect.
 *
 * @param entries - key-value pairs for the record
 * @returns a plain `Record<string, T>`
 */
function wire<T>(entries: ReadonlyArray<readonly [string, T]>): Record<string, T> {
    return Object.fromEntries(entries);
}

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('fetchRuntimeEnvironment', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns only string-valued entries from a successful response', async () => {
        const stub = vi.fn().mockResolvedValue(
            jsonResponse(
                wire<string | number | boolean>([
                    ['API_URL', 'https://api.example.com'],
                    ['COUNT', 42],
                    ['FLAG', true],
                ]),
            ),
        );
        const result = await fetchRuntimeEnvironment(URL, stub);

        expect(result).toStrictEqual(wire([['API_URL', 'https://api.example.com']]));
    });

    it('returns an empty record for a non-ok response even when its body parses', async () => {
        const stub = vi.fn().mockResolvedValue(jsonResponse(wire([['API_URL', 'https://stale.example.com']]), 404));
        const result = await fetchRuntimeEnvironment(URL, stub);

        expect(result).toStrictEqual({});
    });

    it('requests the document uncached, accepting JSON', async () => {
        const stub = vi.fn().mockResolvedValue(jsonResponse({}));

        await fetchRuntimeEnvironment(URL, stub);

        expect(stub).toHaveBeenCalledWith(URL, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
        });
    });

    it('returns an empty record when fetch throws', async () => {
        const stub = vi.fn().mockRejectedValue(new Error('network error'));
        const result = await fetchRuntimeEnvironment(URL, stub);

        expect(result).toStrictEqual({});
    });

    it('returns an empty record when the payload is null', async () => {
        const stub = vi.fn().mockResolvedValue(jsonResponse(null));
        const result = await fetchRuntimeEnvironment(URL, stub);

        expect(result).toStrictEqual({});
    });

    it('returns an empty record when the payload is an array', async () => {
        const stub = vi.fn().mockResolvedValue(jsonResponse(['a', 'b']));
        const result = await fetchRuntimeEnvironment(URL, stub);

        expect(result).toStrictEqual({});
    });

    it('returns an empty record when the payload is a primitive string', async () => {
        const stub = vi.fn().mockResolvedValue(jsonResponse('just a string'));
        const result = await fetchRuntimeEnvironment(URL, stub);

        expect(result).toStrictEqual({});
    });

    it('returns an empty record when the payload is a number', async () => {
        const stub = vi.fn().mockResolvedValue(jsonResponse(123));
        const result = await fetchRuntimeEnvironment(URL, stub);

        expect(result).toStrictEqual({});
    });

    it('passes the given url to the fetch function', async () => {
        const stub = vi.fn().mockResolvedValue(jsonResponse(wire([['KEY', 'val']])));
        await fetchRuntimeEnvironment('/custom/runtime-env.json', stub);

        expect(stub).toHaveBeenCalledWith('/custom/runtime-env.json', expect.objectContaining({ cache: 'no-store' }));
    });

    it('uses globalThis.fetch via the default fetchFn when none is provided', async () => {
        const globalStub = vi.fn().mockResolvedValue(jsonResponse(wire([['RUNTIME', 'yes']])));

        vi.stubGlobal('fetch', globalStub);

        const result = await fetchRuntimeEnvironment(URL);

        expect(result).toStrictEqual(wire([['RUNTIME', 'yes']]));
        expect(globalStub).toHaveBeenCalled();
    });
});
