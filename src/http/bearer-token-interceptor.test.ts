/**
 * Unit tests for bearer-token-interceptor.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { createBearerTokenInterceptor } from './bearer-token-interceptor';
import type { HttpRequest } from './http-client';

/**
 * Build a `Record<string, string>` from an array of `[key, value]` pairs.
 *
 * Wraps `Object.fromEntries` so callers can write wire-field names as plain
 * string literals inside array elements rather than as object-literal keys -
 * keeping non-camelCase header names out of any position that Biome's
 * naming-convention or literal-keys rules inspect.
 *
 * @param entries - key-value pairs for the record
 * @returns a plain `Record<string, string>`
 */
function wire(entries: ReadonlyArray<readonly [string, string]>): Record<string, string> {
    return Object.fromEntries(entries);
}

function makeRequest(headers: Record<string, string> = {}): HttpRequest {
    return { method: 'GET', url: 'https://example.com/', headers, body: undefined };
}

describe('createBearerTokenInterceptor', () => {
    it('returns the request unchanged when the token is null', () => {
        const interceptor = createBearerTokenInterceptor({ getAccessToken: () => null });
        const request = makeRequest();
        const result = interceptor(request);

        expect(result).toBe(request);
    });

    it('adds an authorization header when a token is present', async () => {
        const interceptor = createBearerTokenInterceptor({ getAccessToken: () => 'tok-abc' });
        const request = makeRequest();
        const result = await interceptor(request);

        expect(result.headers).toMatchObject({ authorization: 'Bearer tok-abc' });
    });

    it('does not mutate the original request headers when adding the token', () => {
        const interceptor = createBearerTokenInterceptor({ getAccessToken: () => 'tok-abc' });
        const original: Record<string, string> = {};
        void interceptor(makeRequest(original));

        expect(original).not.toHaveProperty('authorization');
    });

    it('returns the same reference when the request already has an Authorization header', () => {
        const interceptor = createBearerTokenInterceptor({ getAccessToken: () => 'tok-abc' });
        const request = makeRequest(wire([['Authorization', 'Bearer existing']]));
        const result = interceptor(request);

        expect(result).toBe(request);
    });

    it('returns the same reference when the request has a lowercase authorization header', () => {
        const interceptor = createBearerTokenInterceptor({ getAccessToken: () => 'tok-abc' });
        const request = makeRequest({ authorization: 'Bearer existing' });
        const result = interceptor(request);

        expect(result).toBe(request);
    });

    it('returns the same reference when the request has a mixed-case Authorization header', () => {
        const interceptor = createBearerTokenInterceptor({ getAccessToken: () => 'tok-abc' });
        const request = makeRequest(wire([['AUTHORIZATION', 'Bearer existing']]));
        const result = interceptor(request);

        expect(result).toBe(request);
    });
});
