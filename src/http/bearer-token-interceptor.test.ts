/**
 * Tests for the bearer-token request interceptor.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { createBearerTokenInterceptor } from './bearer-token-interceptor';
import type { HttpRequest } from './http-client';

/**
 * Build a header record from pairs, keeping non-camelCase names out of
 * object-literal keys where naming-convention lint rules would reject them.
 */
function wire(entries: ReadonlyArray<readonly [string, string]>): Record<string, string> {
    return Object.fromEntries(entries);
}

/**
 * Build a GET request with the given headers.
 */
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

    it('does not mutate the original headers', () => {
        const interceptor = createBearerTokenInterceptor({ getAccessToken: () => 'tok-abc' });
        const original: Record<string, string> = {};
        void interceptor(makeRequest(original));

        expect(original).not.toHaveProperty('authorization');
    });

    it('attaches the token when only unrelated headers are present', async () => {
        const interceptor = createBearerTokenInterceptor({ getAccessToken: () => 'tok-abc' });
        const request = makeRequest(wire([['x-request-id', 'abc']]));
        const result = await interceptor(request);

        expect(result.headers).toMatchObject(
            wire([
                ['authorization', 'Bearer tok-abc'],
                ['x-request-id', 'abc'],
            ]),
        );
    });

    it.each(['Authorization', 'authorization', 'AUTHORIZATION'])(
        'returns a request that already has an %s header unchanged',
        header => {
            const interceptor = createBearerTokenInterceptor({ getAccessToken: () => 'tok-abc' });
            const request = makeRequest(wire([[header, 'Bearer existing']]));

            expect(interceptor(request)).toBe(request);
        },
    );
});
