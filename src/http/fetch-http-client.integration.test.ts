/**
 * Tests FetchHttpClient error classification over real fetch and a real socket.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FetchHttpClient } from './fetch-http-client';
import type { FetchHttpClientOptions } from './fetch-http-client';
import { CancelledError, HttpValidationError, NetworkError, TimeoutError } from './http-error';

/** Handles one request to the test server. */
type Route = (request: IncomingMessage, response: ServerResponse) => void;

/** What the server received for an upload. */
interface ReceivedUpload {
    /** The content-type header the request arrived with. */
    readonly contentType: string;

    /** The raw request body. */
    readonly body: Buffer;
}

/** A promise plus a flag recording whether it has resolved. */
interface Signal {
    /** Resolves once the signal fires. */
    readonly promise: Promise<void>;

    /** Whether the signal has fired. */
    readonly fired: () => boolean;

    /** Fire the signal. */
    readonly fire: () => void;
}

/** The current test's server, on a fresh port so no connection outlives it. */
let server: Server;

/** The server's base URL, set once it listens. */
let baseUrl = '';

/** How the server answers the current test's requests. */
let route: Route = (_request, response) => {
    response.writeHead(404).end();
};

/**
 * Create a one-shot signal the test can await or inspect.
 */
function createSignal(): Signal {
    let fired = false;
    let fire!: () => void;

    const promise = new Promise<void>(resolve => {
        fire = () => {
            fired = true;
            resolve();
        };
    });

    return { promise, fired: () => fired, fire };
}

/**
 * Write a JSON head and a first chunk, leaving the body unfinished.
 */
function stallAfterFirstChunk(response: ServerResponse): void {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"partial":');
}

/**
 * Build a client over the global fetch, firing the signal when headers arrive.
 */
function makeClient(headersSeen: Signal, extra: Partial<FetchHttpClientOptions> = {}): FetchHttpClient {
    return new FetchHttpClient({
        baseUrl,
        fetchFn: async (input, init) => {
            const response = await fetch(input, init);

            headersSeen.fire();

            return response;
        },
        ...extra,
    });
}

/**
 * Await a request's rejection, recording whether headers had arrived by then.
 */
function failureOf(promise: Promise<unknown>, headersSeen: Signal): Promise<[unknown, boolean]> {
    return promise.then(
        () => [undefined, headersSeen.fired()],
        (error: unknown) => [error, headersSeen.fired()],
    );
}

beforeEach(async () => {
    server = createServer((request, response) => {
        route(request, response);
    });

    await new Promise<void>(resolve => {
        server.listen(0, '127.0.0.1', resolve);
    });

    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
    server.closeAllConnections();

    await new Promise<void>((resolve, reject) => {
        server.close(error => {
            if (error === undefined) {
                resolve();
            } else {
                reject(error);
            }
        });
    });
});

describe('FetchHttpClient over a real socket', { timeout: 10_000 }, () => {
    it('times out while the response headers are stalled', async () => {
        const headersSeen = createSignal();

        route = () => undefined;

        const [error, seen] = await failureOf(makeClient(headersSeen, { timeout: 100 }).get('/stall'), headersSeen);

        expect(error).toBeInstanceOf(TimeoutError);
        expect(seen).toBe(false);
    });

    it('times out while the response body is stalled after its headers arrived', async () => {
        const headersSeen = createSignal();

        route = (_request, response) => {
            stallAfterFirstChunk(response);
        };

        const [error, seen] = await failureOf(
            makeClient(headersSeen, { timeout: 1_000 }).get('/stall-body'),
            headersSeen,
        );

        expect(error).toBeInstanceOf(TimeoutError);
        expect(seen).toBe(true);
    });

    it('fails as a network error when the server resets mid-body', async () => {
        const headersSeen = createSignal();
        const responses: ServerResponse[] = [];

        route = (_request, response) => {
            responses.push(response);
            stallAfterFirstChunk(response);
        };

        const pending = failureOf(makeClient(headersSeen).get('/reset'), headersSeen);

        await headersSeen.promise;
        responses[0]?.destroy();

        const [error] = await pending;

        expect(error).toBeInstanceOf(NetworkError);
        expect(error).not.toBeInstanceOf(TimeoutError);
        expect((error as NetworkError).message).toBe(`GET ${baseUrl}/reset failed while reading the response body.`);
    });

    it('cancels a download the caller aborts mid-body without reporting it', async () => {
        const bodyStarted = createSignal();
        const caller = new AbortController();
        const onResponseError = vi.fn();

        route = (_request, response) => {
            response.writeHead(200, { 'content-type': 'application/octet-stream' });
            response.write('first chunk');
        };

        const client = new FetchHttpClient({
            baseUrl,
            onResponseError,
            fetchFn: async (input, init) => {
                const response = await fetch(input, init);
                const tap = new TransformStream<Uint8Array, Uint8Array>({
                    transform: (chunk, controller) => {
                        bodyStarted.fire();
                        controller.enqueue(chunk);
                    },
                });

                return new Response(response.body?.pipeThrough(tap) ?? null, {
                    status: response.status,
                    headers: response.headers,
                });
            },
        });

        const pending = client.download('/file', { signal: caller.signal }).catch((error: unknown) => error);

        await bodyStarted.promise;
        caller.abort();

        expect(await pending).toBeInstanceOf(CancelledError);
        expect(onResponseError).not.toHaveBeenCalled();
    });

    it('uploads FormData as multipart with its own boundary over an inherited JSON content-type', async () => {
        const received: ReceivedUpload[] = [];

        route = (request, response) => {
            const chunks: Buffer[] = [];

            request.on('data', (chunk: Buffer) => chunks.push(chunk));
            request.on('end', () => {
                received.push({ contentType: request.headers['content-type'] ?? '', body: Buffer.concat(chunks) });
                response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
            });
        };

        const form = new FormData();

        form.append('file', new Blob(['hello world'], { type: 'text/plain' }), 'notes.txt');

        await makeClient(createSignal(), { defaultHeaders: { 'content-type': 'application/json' } }).post(
            '/upload',
            form,
        );

        const [upload] = received;
        const parsed = await new Response(upload?.body, {
            headers: { 'content-type': upload?.contentType ?? '' },
        }).formData();
        const file = parsed.get('file') as File;

        expect(upload?.contentType).toMatch(/^multipart\/form-data; boundary=\S+$/u);
        expect(file.name).toBe('notes.txt');
        expect(await file.text()).toBe('hello world');
    });

    it('rejects a toolkit validation envelope with its field errors', async () => {
        route = (_request, response) => {
            response.writeHead(422, { 'content-type': 'application/json' }).end(
                JSON.stringify({
                    error: {
                        status: 422,
                        code: 10106,
                        title: 'Invalid Input',
                        detail: 'The given data was invalid.',
                        meta: { email: ['The email field is required.'] },
                    },
                }),
            );
        };

        const [error] = await failureOf(makeClient(createSignal()).post('/users', {}), createSignal());

        expect(error).toBeInstanceOf(HttpValidationError);
        expect((error as HttpValidationError).errors).toStrictEqual({ email: ['The email field is required.'] });
    });
});
