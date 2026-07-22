/**
 * Unit tests for FetchHttpClient - request construction (verbs, URLs, query
 * parameters, body/content-type, default headers).
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import { FetchHttpClient } from './fetch-http-client';

// ---------------------------------------------------------------------------
// Stub type
// ---------------------------------------------------------------------------

/** Explicit overload signature so mock.calls carries a typed tuple, not []. */
type FetchArgs = [input: Request | string | URL, init?: RequestInit];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function emptyResponse(status = 204): Response {
    return new Response(null, { status });
}

function makeFetch(
    impl: (...args: FetchArgs) => Promise<Response>,
): ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>> {
    return vi.fn<(...args: FetchArgs) => Promise<Response>>(impl);
}

function makeClient(
    fetchFn: typeof fetch,
    extra: Partial<ConstructorParameters<typeof FetchHttpClient>[0]> = {},
): FetchHttpClient {
    return new FetchHttpClient({ baseUrl: 'https://api.example.com', fetchFn, ...extra });
}

/**
 * Return the URL from the most-recent call to a fetch stub.
 *
 * @param fn - the fetch stub
 * @returns the URL string
 */
function lastUrl(fn: ReturnType<typeof makeFetch>): string {
    const call = fn.mock.calls.at(-1);
    expect(call).toBeDefined();
    const raw = call?.[0];
    return typeof raw === 'string' ? raw : String(raw);
}

/**
 * Return the RequestInit from the most-recent call to a fetch stub.
 *
 * @param fn - the fetch stub
 * @returns the RequestInit object (may be undefined when not passed)
 */
function lastInit(fn: ReturnType<typeof makeFetch>): RequestInit {
    const call = fn.mock.calls.at(-1);
    expect(call).toBeDefined();
    return call?.[1] ?? {};
}

/**
 * Return the headers record from the most-recent call to a fetch stub.
 *
 * @param fn - the fetch stub
 * @returns the headers as a plain record
 */
function lastHeaders(fn: ReturnType<typeof makeFetch>): Record<string, string> {
    // Cast is proven safe: #buildRequestInit always writes a plain object
    // literal into init.headers, so the value is always Record<string, string>
    // at runtime.
    return (lastInit(fn).headers ?? {}) as Record<string, string>;
}

// ---------------------------------------------------------------------------
// HTTP verbs
// ---------------------------------------------------------------------------

describe('FetchHttpClient - verbs', () => {
    it('GET sends a GET request to the correct URL', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ ok: true }));
        const client = makeClient(fetchFn);

        await client.get('/users');

        expect(lastUrl(fetchFn)).toBe('https://api.example.com/users');
        expect(lastInit(fetchFn).method).toBe('GET');
    });

    it('POST sends a POST request', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ id: 1 }));
        const client = makeClient(fetchFn);

        await client.post('/users', { name: 'Alice' });

        expect(lastInit(fetchFn).method).toBe('POST');
    });

    it('PUT sends a PUT request', async () => {
        const fetchFn = makeFetch(async () => emptyResponse(200));
        const client = makeClient(fetchFn);

        await client.put('/users/1', { name: 'Bob' });

        expect(lastInit(fetchFn).method).toBe('PUT');
    });

    it('PATCH sends a PATCH request', async () => {
        const fetchFn = makeFetch(async () => emptyResponse(200));
        const client = makeClient(fetchFn);

        await client.patch('/users/1', { active: false });

        expect(lastInit(fetchFn).method).toBe('PATCH');
    });

    it('DELETE sends a DELETE request', async () => {
        const fetchFn = makeFetch(async () => emptyResponse(204));
        const client = makeClient(fetchFn);

        await client.delete('/users/1');

        expect(lastInit(fetchFn).method).toBe('DELETE');
    });
});

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

describe('FetchHttpClient - URL construction', () => {
    it('trims a trailing slash from baseUrl', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = new FetchHttpClient({ baseUrl: 'https://api.example.com/', fetchFn });

        await client.get('/items');

        expect(lastUrl(fetchFn)).toBe('https://api.example.com/items');
    });

    it('trims a leading slash from path', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn);

        await client.get('/items');

        expect(lastUrl(fetchFn)).toBe('https://api.example.com/items');
    });

    it('handles a path without a leading slash', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn);

        await client.get('items');

        expect(lastUrl(fetchFn)).toBe('https://api.example.com/items');
    });

    it('trims multiple leading slashes from path', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({}));
        const client = makeClient(fetchFn);

        await client.get('///items');

        expect(lastUrl(fetchFn)).toBe('https://api.example.com/items');
    });
});

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

describe('FetchHttpClient - query parameters', () => {
    it('appends string query params', async () => {
        const fetchFn = makeFetch(async () => jsonResponse([]));
        const client = makeClient(fetchFn);

        await client.get('/search', { query: { q: 'hello' } });

        expect(lastUrl(fetchFn)).toBe('https://api.example.com/search?q=hello');
    });

    it('appends number query params', async () => {
        const fetchFn = makeFetch(async () => jsonResponse([]));
        const client = makeClient(fetchFn);

        await client.get('/items', { query: { page: 2 } });

        expect(lastUrl(fetchFn)).toBe('https://api.example.com/items?page=2');
    });

    it('appends boolean query params', async () => {
        const fetchFn = makeFetch(async () => jsonResponse([]));
        const client = makeClient(fetchFn);

        await client.get('/items', { query: { active: true } });

        expect(lastUrl(fetchFn)).toBe('https://api.example.com/items?active=true');
    });

    it('skips undefined query param values', async () => {
        const fetchFn = makeFetch(async () => jsonResponse([]));
        const client = makeClient(fetchFn);

        await client.get('/items', { query: { page: undefined } });

        expect(lastUrl(fetchFn)).toBe('https://api.example.com/items');
    });

    it('omits the ? when there are no query params', async () => {
        const fetchFn = makeFetch(async () => jsonResponse([]));
        const client = makeClient(fetchFn);

        await client.get('/items');

        expect(lastUrl(fetchFn)).not.toContain('?');
    });
});

// ---------------------------------------------------------------------------
// Request body & content-type
// ---------------------------------------------------------------------------

describe('FetchHttpClient - body and content-type', () => {
    it('serialises the body to JSON for POST', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ id: 1 }));
        const client = makeClient(fetchFn);

        await client.post('/users', { name: 'Alice' });

        expect(lastInit(fetchFn).body).toBe('{"name":"Alice"}');
    });

    it('adds content-type application/json when body is present and header absent', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ id: 1 }));
        const client = makeClient(fetchFn);

        await client.post('/users', { name: 'Alice' });

        expect(lastHeaders(fetchFn)['content-type']).toBe('application/json');
    });

    it('does not override Content-Type when caller sets it (title-case)', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ id: 1 }));
        const client = makeClient(fetchFn);

        await client.post('/upload', { data: 1 }, { headers: { 'Content-Type': 'text/csv' } });

        const headers = lastHeaders(fetchFn);

        expect(headers['Content-Type']).toBe('text/csv');
        expect(headers['content-type']).toBeUndefined();
    });

    it('does not override content-type when caller sets it (lowercase)', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ id: 1 }));
        const client = makeClient(fetchFn);

        await client.post('/upload', { data: 1 }, { headers: { 'content-type': 'text/csv' } });

        expect(lastHeaders(fetchFn)['content-type']).toBe('text/csv');
    });

    it('sends no body and no content-type for GET', async () => {
        const fetchFn = makeFetch(async () => jsonResponse([]));
        const client = makeClient(fetchFn);

        await client.get('/items');

        const init = lastInit(fetchFn);
        const headerKeys = Object.keys(lastHeaders(fetchFn)).map(headerKey => headerKey.toLowerCase());

        expect(init.body).toBeUndefined();
        expect(headerKeys).not.toContain('content-type');
    });

    it('sends no body and no content-type for DELETE', async () => {
        const fetchFn = makeFetch(async () => emptyResponse(204));
        const client = makeClient(fetchFn);

        await client.delete('/items/1');

        const init = lastInit(fetchFn);
        const headerKeys = Object.keys(lastHeaders(fetchFn)).map(headerKey => headerKey.toLowerCase());

        expect(init.body).toBeUndefined();
        expect(headerKeys).not.toContain('content-type');
    });

    it('passes a FormData body through unchanged and does not set content-type', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ ok: true }));
        const client = makeClient(fetchFn);
        const formData = new FormData();
        formData.append('file', new Blob(['content']), 'file.txt');

        await client.post('/uploads', formData);

        const init = lastInit(fetchFn);
        const headerKeys = Object.keys(lastHeaders(fetchFn)).map(headerKey => headerKey.toLowerCase());

        expect(init.body).toBe(formData);
        expect(headerKeys).not.toContain('content-type');
    });

    it('passes a Blob body through unchanged and does not set content-type', async () => {
        const fetchFn = makeFetch(async () => jsonResponse({ ok: true }));
        const client = makeClient(fetchFn);
        const blob = new Blob(['binary data'], { type: 'application/octet-stream' });

        await client.post('/uploads', blob);

        const init = lastInit(fetchFn);
        const headerKeys = Object.keys(lastHeaders(fetchFn)).map(headerKey => headerKey.toLowerCase());

        expect(init.body).toBe(blob);
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

// ---------------------------------------------------------------------------
// Default headers
// ---------------------------------------------------------------------------

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
