/**
 * Benchmarks for issuing requests through the HTTP client.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe } from 'vitest';

import { measure } from './support/measure';

import { FetchHttpClient } from '../src/http/fetch-http-client';
import type { HttpRequest } from '../src/http/http-client';
import type { RawRecord } from '../src/query/envelope';
import { ResourceClient } from '../src/query/resource-client';

const PAGE = JSON.stringify({
    data: Array.from({ length: 100 }, (_, index) => ({ id: index, total: index * 10 })),
    meta: { continue: true, total: 1000, count: 100 },
    links: { self: null, first: null, prev: null, next: null, last: null },
});

/**
 * Build a client whose fetch resolves `body` as JSON straight away.
 */
function clientServing(body: string): FetchHttpClient {
    return new FetchHttpClient({
        baseUrl: 'https://api.example.test',
        timeout: 30_000,
        fetchFn: () => Promise.resolve(new Response(body, { headers: { 'content-type': 'application/json' } })),
        requestInterceptors: [
            (request: HttpRequest) => ({ ...request, headers: { ...request.headers, authorization: 'Bearer token' } }),
            (request: HttpRequest) => ({ ...request, headers: { ...request.headers, 'x-locale': 'en-GB' } }),
        ],
    });
}

describe('FetchHttpClient', () => {
    const client = clientServing('{"data":{"id":1}}');
    const controller = new AbortController();

    measure('sends a GET through two interceptors, a timeout and a signal', async () => {
        await client.get('orders/1', { signal: controller.signal });
    });
});

describe('ResourceClient', () => {
    const resources = new ResourceClient({ client: clientServing(PAGE), path: 'orders', map: (raw: RawRecord) => raw });

    measure('lists a 100-record page', async () => {
        await resources.list();
    });
});
