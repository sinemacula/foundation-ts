/**
 * Tests for how FetchHttpClient builds the requests it sends.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import { FetchHttpClient } from './fetch-http-client';
import type { HttpRequest } from './http-client';

/** The fetch call signature, so mock.calls carries a typed tuple. */
type FetchArgs = [input: Request | string | URL, init?: RequestInit];

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
 * Build a response without a body.
 */
function emptyResponse(status = 204): Response {
    return new Response(null, { status });
}

/**
 * Wrap a fetch implementation in a typed stub.
 */
function makeFetch(
    impl: (...args: FetchArgs) => Promise<Response>,
): ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>> {
    return vi.fn<(...args: FetchArgs) => Promise<Response>>(impl);
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
 * Return the URL from the most recent call to a fetch stub.
 */
function lastUrl(fn: ReturnType<typeof makeFetch>): string {
    const call = fn.mock.calls.at(-1);
    expect(call).toBeDefined();
    const raw = call?.[0];
    return typeof raw === 'string' ? raw : String(raw);
}

/**
 * Return the RequestInit from the most recent call to a fetch stub, or an empty
 * one when none was passed.
 */
function lastInit(fn: ReturnType<typeof makeFetch>): RequestInit {
    const call = fn.mock.calls.at(-1);
    expect(call).toBeDefined();
    return call?.[1] ?? {};
}

/**
 * Return the headers record from the most recent call to a fetch stub.
 */
function lastHeaders(fn: ReturnType<typeof makeFetch>): Record<string, string> {
    return (lastInit(fn).headers ?? {}) as Record<string, string>;
}

/**
 * Build a FormData carrying one file.
 */
function formDataWithFile(): FormData {
    const formData = new FormData();

    formData.append('file', new Blob(['content']), 'file.txt');

    return formData;
}

describe('FetchHttpClient - verbs', () => {
    it('sends a GET request to the resolved URL', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ ok: true }));
        const client = makeClient(fetchFn);

        await client.get('/users');

        expect(lastUrl(fetchFn)).toBe('https://api.example.com/users');
        expect(lastInit(fetchFn).method).toBe('GET');
    });

    it.each([
        ['POST', { id: 1 }, (client: FetchHttpClient) => client.post('/users', { name: 'Alice' })],
        ['PUT', { id: 1, name: 'Bob' }, (client: FetchHttpClient) => client.put('/users/1', { name: 'Bob' })],
        ['PATCH', { id: 1, active: false }, (client: FetchHttpClient) => client.patch('/users/1', { active: false })],
        ['DELETE', { deleted: true }, (client: FetchHttpClient) => client.delete('/users/1')],
    ] as const)('sends a %s request and resolves the parsed body', async (verb, body, invoke) => {
        const fetchFn = makeFetch(async () => jsonResponse(body));

        const result = await invoke(makeClient(fetchFn));

        expect(lastInit(fetchFn).method).toBe(verb);
        expect(result).toEqual(body);
    });
});

describe('FetchHttpClient - URL construction', () => {
    it.each([
        ['trims a trailing slash from the base URL', 'https://api.example.com/', '/items', '/items'],
        ['trims a leading slash from the path', 'https://api.example.com', '/items', '/items'],
        ['handles a path without a leading slash', 'https://api.example.com', 'items', '/items'],
        ['trims multiple leading slashes from the path', 'https://api.example.com', '///items', '/items'],
        ['trims multiple trailing slashes from the base URL', 'https://api.example.com//', '/items', '/items'],
        ['preserves interior slashes in the path', 'https://api.example.com', 'users/1/orders', '/users/1/orders'],
    ])('%s', async (_case, baseUrl, path, expected) => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = new FetchHttpClient({ baseUrl, fetchFn });

        await client.get(path);

        expect(lastUrl(fetchFn)).toBe(`https://api.example.com${expected}`);
    });
});

describe('FetchHttpClient - query parameters', () => {
    it.each([
        ['appends a string query param', { q: 'hello' }, '/items?q=hello'],
        ['appends a number query param', { page: 2 }, '/items?page=2'],
        ['appends a boolean query param', { active: true }, '/items?active=true'],
        ['skips an undefined query param', { page: undefined }, '/items'],
    ])('%s', async (_case, query, expected) => {
        const fetchFn = makeFetch(async () => jsonResponse([]));
        const client = makeClient(fetchFn);

        await client.get('/items', { query });

        expect(lastUrl(fetchFn)).toBe(`https://api.example.com${expected}`);
    });

    it('omits the ? when there are no query params', async () => {
        const fetchFn = makeFetch(async () => jsonResponse([]));
        const client = makeClient(fetchFn);

        await client.get('/items');

        expect(lastUrl(fetchFn)).not.toContain('?');
    });
});

describe('FetchHttpClient - body and content-type', () => {
    it('serialises the body to JSON for POST', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ id: 1 }));
        const client = makeClient(fetchFn);

        await client.post('/users', { name: 'Alice' });

        expect(lastInit(fetchFn).body).toBe('{"name":"Alice"}');
    });

    it('adds a JSON content-type to a body without one', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ id: 1 }));
        const client = makeClient(fetchFn);

        await client.post('/users', { name: 'Alice' });

        expect(lastHeaders(fetchFn)['content-type']).toBe('application/json');
    });

    it('still adds the JSON content-type when only unrelated headers are set', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ id: 1 }));
        const client = makeClient(fetchFn);

        await client.post('/upload', { data: 1 }, { headers: { 'x-request-id': 'abc' } });

        const headers = lastHeaders(fetchFn);

        expect(headers['content-type']).toBe('application/json');
        expect(headers['x-request-id']).toBe('abc');
    });

    it('keeps a title-case Content-Type the caller sets', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ id: 1 }));
        const client = makeClient(fetchFn);

        await client.post('/upload', { data: 1 }, { headers: { 'Content-Type': 'text/csv' } });

        const headers = lastHeaders(fetchFn);

        expect(headers['Content-Type']).toBe('text/csv');
        expect(headers['content-type']).toBeUndefined();
    });

    it('keeps a lowercase content-type the caller sets', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ id: 1 }));
        const client = makeClient(fetchFn);

        await client.post('/upload', { data: 1 }, { headers: { 'content-type': 'text/csv' } });

        expect(lastHeaders(fetchFn)['content-type']).toBe('text/csv');
    });

    it.each([
        ['GET', (client: FetchHttpClient) => client.get('/items'), jsonResponse([])],
        ['DELETE', (client: FetchHttpClient) => client.delete('/items/1'), emptyResponse(204)],
    ] as const)('sends no body and no content-type for %s', async (_verb, invoke, response) => {
        const fetchFn = makeFetch(async () => response);

        await invoke(makeClient(fetchFn));

        const headerKeys = Object.keys(lastHeaders(fetchFn)).map(headerKey => headerKey.toLowerCase());

        expect(lastInit(fetchFn).body).toBeUndefined();
        expect(headerKeys).not.toContain('content-type');
    });

    it.each([
        ['FormData', formDataWithFile()],
        ['Blob', new Blob(['binary data'], { type: 'application/octet-stream' })],
    ])('passes a %s body through unchanged without a content-type', async (_type, body) => {
        const fetchFn = makeFetch(async () => jsonResponse({ ok: true }));
        const client = makeClient(fetchFn);

        await client.post('/uploads', body);

        const headerKeys = Object.keys(lastHeaders(fetchFn)).map(headerKey => headerKey.toLowerCase());

        expect(lastInit(fetchFn).body).toBe(body);
        expect(headerKeys).not.toContain('content-type');
    });

    it('preserves other headers alongside a FormData body', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ ok: true }));
        const client = makeClient(fetchFn);
        const formData = new FormData();

        await client.post('/uploads', formData, { headers: { 'x-trace': '1' } });

        expect(lastHeaders(fetchFn)['x-trace']).toBe('1');
    });
});

describe('FetchHttpClient - defaultHeaders', () => {
    it('merges default headers into every request', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn, { defaultHeaders: { 'x-api-key': 'secret' } });

        await client.get('/items');

        expect(lastHeaders(fetchFn)['x-api-key']).toBe('secret');
    });

    it('allows per-call headers to override default headers', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn, { defaultHeaders: { 'x-api-key': 'secret' } });

        await client.get('/items', { headers: { 'x-api-key': 'override' } });

        expect(lastHeaders(fetchFn)['x-api-key']).toBe('override');
    });
});

describe('FetchHttpClient - accept header', () => {
    it('asks for JSON by default', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn);

        await client.post('/items', { name: 'Alice' });

        expect(lastHeaders(fetchFn)).toStrictEqual({ accept: 'application/json', 'content-type': 'application/json' });
    });

    it.each([
        ['GET', (client: FetchHttpClient) => client.get('/items')],
        ['PUT', (client: FetchHttpClient) => client.put('/items')],
        ['PATCH', (client: FetchHttpClient) => client.patch('/items')],
        ['DELETE', (client: FetchHttpClient) => client.delete('/items')],
    ] as const)('asks for JSON on a %s', async (_verb, invoke) => {
        const fetchFn = makeFetch(async () => jsonResponse({}));

        await invoke(makeClient(fetchFn));

        expect(lastHeaders(fetchFn)).toStrictEqual({ accept: 'application/json' });
    });

    it('asks downloads for any type while still preferring JSON errors', async () => {
        const fetchFn = makeFetch(async () => new Response(new Blob(['bytes']), { status: 200 }));
        const client = makeClient(fetchFn);

        await client.download('/files/1');

        expect(lastHeaders(fetchFn)).toStrictEqual({ accept: 'application/json, */*;q=0.8' });
    });

    it('lets a default header replace the default accept, whatever its case', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn, { defaultHeaders: { Accept: 'application/vnd.api+json' } });

        await client.get('/items');

        expect(lastHeaders(fetchFn)).toStrictEqual({ Accept: 'application/vnd.api+json' });
    });

    it('lets a per-request header replace the default accept', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn);

        await client.get('/items', { headers: { accept: 'text/csv' } });

        expect(lastHeaders(fetchFn)).toStrictEqual({ accept: 'text/csv' });
    });

    it('shows the default accept to request interceptors', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const seen: Record<string, string>[] = [];
        const client = makeClient(fetchFn, {
            requestInterceptors: [
                request => {
                    seen.push({ ...request.headers });

                    return request;
                },
            ],
        });

        await client.get('/items');

        expect(seen).toStrictEqual([{ accept: 'application/json' }]);
    });
});

describe('FetchHttpClient - credentials', () => {
    it.each(['omit', 'same-origin', 'include'] as const)(
        'sends the %s credentials mode to fetch',
        async credentials => {
            const fetchFn = makeFetch(async () => jsonResponse({}));
            const client = makeClient(fetchFn);

            await client.post('/session', {}, { credentials });

            expect(lastInit(fetchFn).credentials).toBe(credentials);
        },
    );

    it('leaves the credentials mode to the platform when the request sets none', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn);

        await client.get('/items');

        expect(lastInit(fetchFn)).not.toHaveProperty('credentials');
    });

    it('shows interceptors the credentials mode and sends the one they return', async () => {
        const seen: HttpRequest[] = [];
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn, {
            requestInterceptors: [
                request => {
                    seen.push(request);

                    return { ...request, credentials: 'omit' };
                },
            ],
        });

        await client.get('/items', { credentials: 'include' });

        expect(seen.map(request => request.credentials)).toStrictEqual(['include']);
        expect(lastInit(fetchFn).credentials).toBe('omit');
    });

    it('leaves the credentials mode off the resolved request when the request sets none', async () => {
        const seen: HttpRequest[] = [];
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn, {
            requestInterceptors: [
                request => {
                    seen.push(request);

                    return request;
                },
            ],
        });

        await client.get('/items');

        expect(seen[0]).not.toHaveProperty('credentials');
    });
});
