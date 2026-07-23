/**
 * Unit tests for ResourceClient.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import type { HttpClient, HttpRequestOptions } from '../http/http-client';
import { ApiQuery } from './api-query';
import type { RawRecord } from './envelope';
import { ResourceClient } from './resource-client';

/** A minimal domain type used to exercise the resource client. */
interface Widget {
    readonly id: string;
    readonly name: string;
}

/** The shape of a single call recorded by {@link FakeHttpClient}. */
interface RecordedCall {
    readonly method: string;
    readonly path: string;
    readonly body: unknown;
    readonly options: HttpRequestOptions | undefined;
}

/**
 * An in-memory {@link HttpClient} fake that records every call and replays
 * queued response payloads in order.
 */
class FakeHttpClient implements HttpClient {
    readonly calls: RecordedCall[] = [];
    readonly #queue: unknown[] = [];

    /**
     * Queue a response payload for the next call.
     *
     * @param value - the payload the next call resolves with
     */
    queueResponse(value: unknown): void {
        this.#queue.push(value);
    }

    get<T>(path: string, options?: HttpRequestOptions): Promise<T> {
        return this.#consume('GET', path, undefined, options);
    }

    post<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
        return this.#consume('POST', path, body, options);
    }

    put<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
        return this.#consume('PUT', path, body, options);
    }

    patch<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
        return this.#consume('PATCH', path, body, options);
    }

    delete<T>(path: string, options?: HttpRequestOptions): Promise<T> {
        return this.#consume('DELETE', path, undefined, options);
    }

    download(path: string, options?: HttpRequestOptions): Promise<Blob> {
        return this.#consume('DOWNLOAD', path, undefined, options);
    }

    #consume<T>(method: string, path: string, body: unknown, options: HttpRequestOptions | undefined): Promise<T> {
        this.calls.push({ method, path, body, options });

        return Promise.resolve(this.#queue.shift() as T);
    }
}

/**
 * Build a `Record<string, unknown>` from an array of `[key, value]` pairs.
 *
 * Keeps snake_case wire-field names out of object-literal key positions so
 * Biome's naming-convention rule never sees them.
 *
 * @param entries - key-value pairs for the record
 * @returns a plain `Record<string, unknown>`
 */
function wire(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
    return Object.fromEntries(entries);
}

/** Build a raw widget wire record. */
function widgetRecord(id: string, name: string): Record<string, unknown> {
    return wire([
        ['id', id],
        ['name', name],
    ]);
}

/** Build a valid single-widget envelope. */
function widgetEnvelope(id: string, name: string): Record<string, unknown> {
    return { data: widgetRecord(id, name) };
}

/**
 * Validate and map a raw record onto a `Widget`.
 *
 * @param raw - the raw wire record
 * @returns the mapped widget
 * @throws Error when required fields are missing or of the wrong type
 */
function mapWidget(raw: RawRecord): Widget {
    if (typeof raw['id'] !== 'string' || typeof raw['name'] !== 'string') {
        throw new Error('The widget response did not match the expected shape.');
    }

    return { id: raw['id'], name: raw['name'] };
}

/** Build a `ResourceClient<Widget>` wired against a fresh `FakeHttpClient`. */
function createResource(path = 'widgets'): { client: FakeHttpClient; resource: ResourceClient<Widget> } {
    const client = new FakeHttpClient();
    const resource = new ResourceClient({ client, path, map: mapWidget });

    return { client, resource };
}

describe('ResourceClient', () => {
    describe('list', () => {
        it('unwraps a list envelope into mapped items and meta', async () => {
            const { client, resource } = createResource();
            client.queueResponse({
                data: [widgetRecord('w1', 'Widget One')],
                meta: wire([
                    ['current_page', 1],
                    ['last_page', 1],
                    ['per_page', 10],
                    ['total', 1],
                ]),
            });

            const result = await resource.list();

            expect(result.items).toEqual([{ id: 'w1', name: 'Widget One' }]);
            expect(result.meta).toEqual({ currentPage: 1, lastPage: 1, perPage: 10, total: 1 });
        });

        it('sends a GET request to the resource path', async () => {
            const { client, resource } = createResource();
            client.queueResponse({ data: [] });

            await resource.list();

            const call = client.calls.at(0);

            expect(call?.method).toBe('GET');
            expect(call?.path).toBe('widgets');
        });

        it('propagates malformed-envelope errors', async () => {
            const { client, resource } = createResource();
            client.queueResponse('not-a-record');

            await expect(resource.list()).rejects.toThrow('The response did not match the expected envelope shape.');
        });

        it('propagates mapper errors', async () => {
            const { client, resource } = createResource();
            client.queueResponse({ data: [wire([['id', 'w1']])] });

            await expect(resource.list()).rejects.toThrow('The widget response did not match the expected shape.');
        });

        it('sends no query parameters when neither an ApiQuery nor explicit options are given', async () => {
            const { client, resource } = createResource();
            client.queueResponse({ data: [] });

            await resource.list();

            expect(client.calls.at(0)?.options).toBeUndefined();
        });

        it('sends the ApiQuery parameters when only a query is given', async () => {
            const { client, resource } = createResource();
            client.queueResponse({ data: [] });

            await resource.list(ApiQuery.create().page(2).limit(10));

            expect(client.calls.at(0)?.options?.query).toEqual({ page: 2, limit: 10 });
        });

        it('merges ApiQuery parameters with explicit options.query, explicit wins on collision', async () => {
            const { client, resource } = createResource();
            client.queueResponse({ data: [] });

            await resource.list(ApiQuery.create().page(2).limit(10), { query: { page: 9, filters: 'x' } });

            expect(client.calls.at(0)?.options?.query).toEqual({ page: 9, limit: 10, filters: 'x' });
        });

        it('passes through the abort signal when no query is given', async () => {
            const { client, resource } = createResource();
            client.queueResponse({ data: [] });
            const controller = new AbortController();

            await resource.list(undefined, { signal: controller.signal });

            const call = client.calls.at(0);

            expect(call?.options?.signal).toBe(controller.signal);
            expect(call?.options?.query).toBeUndefined();
        });
    });

    describe('show', () => {
        it('unwraps a single-resource envelope into a mapped value', async () => {
            const { client, resource } = createResource();
            client.queueResponse(widgetEnvelope('w1', 'Widget One'));

            expect(await resource.show('w1')).toEqual({ id: 'w1', name: 'Widget One' });
        });

        it('sends a GET request to the joined resource path', async () => {
            const { client, resource } = createResource();
            client.queueResponse(widgetEnvelope('w1', 'Widget One'));

            await resource.show('w1');

            const call = client.calls.at(0);

            expect(call?.method).toBe('GET');
            expect(call?.path).toBe('widgets/w1');
        });

        it('joins a trailing-slash path and a leading-slash id without a double slash', async () => {
            const { client, resource } = createResource('widgets/');
            client.queueResponse(widgetEnvelope('w1', 'Widget One'));

            await resource.show('/w1');

            expect(client.calls.at(0)?.path).toBe('widgets/w1');
        });

        it('merges an ApiQuery into the request options', async () => {
            const { client, resource } = createResource();
            client.queueResponse(widgetEnvelope('w1', 'Widget One'));

            await resource.show('w1', ApiQuery.create().fields(['id']));

            expect(client.calls.at(0)?.options?.query).toEqual({ fields: 'id' });
        });

        it('propagates malformed-envelope errors', async () => {
            const { client, resource } = createResource();
            client.queueResponse(null);

            await expect(resource.show('w1')).rejects.toThrow(
                'The response did not match the expected envelope shape.',
            );
        });

        it('propagates mapper errors', async () => {
            const { client, resource } = createResource();
            client.queueResponse({ data: wire([['id', 'w1']]) });

            await expect(resource.show('w1')).rejects.toThrow('The widget response did not match the expected shape.');
        });
    });

    describe('create', () => {
        it('posts the body to the resource path and unwraps the response', async () => {
            const { client, resource } = createResource();
            client.queueResponse(widgetEnvelope('w1', 'Widget One'));

            const created = await resource.create({ name: 'Widget One' });

            const call = client.calls.at(0);

            expect(call?.method).toBe('POST');
            expect(call?.path).toBe('widgets');
            expect(call?.body).toEqual({ name: 'Widget One' });
            expect(created).toEqual({ id: 'w1', name: 'Widget One' });
        });

        it('passes through request options', async () => {
            const { client, resource } = createResource();
            client.queueResponse(widgetEnvelope('w1', 'Widget One'));
            const controller = new AbortController();

            await resource.create({ name: 'Widget One' }, { signal: controller.signal });

            expect(client.calls.at(0)?.options?.signal).toBe(controller.signal);
        });

        it('propagates malformed-envelope errors', async () => {
            const { client, resource } = createResource();
            client.queueResponse('bad');

            await expect(resource.create({ name: 'Widget One' })).rejects.toThrow(
                'The response did not match the expected envelope shape.',
            );
        });
    });

    describe('update', () => {
        it('patches the joined resource path with the body and unwraps the response', async () => {
            const { client, resource } = createResource();
            client.queueResponse(widgetEnvelope('w1', 'Widget One (renamed)'));

            const updated = await resource.update('w1', { name: 'Widget One (renamed)' });

            const call = client.calls.at(0);

            expect(call?.method).toBe('PATCH');
            expect(call?.path).toBe('widgets/w1');
            expect(call?.body).toEqual({ name: 'Widget One (renamed)' });
            expect(updated.name).toBe('Widget One (renamed)');
        });

        it('passes through request options', async () => {
            const { client, resource } = createResource();
            client.queueResponse(widgetEnvelope('w1', 'Widget One'));
            const controller = new AbortController();

            await resource.update('w1', { name: 'Widget One' }, { signal: controller.signal });

            expect(client.calls.at(0)?.options?.signal).toBe(controller.signal);
        });

        it('propagates malformed-envelope errors', async () => {
            const { client, resource } = createResource();
            client.queueResponse(42);

            await expect(resource.update('w1', { name: 'x' })).rejects.toThrow(
                'The response did not match the expected envelope shape.',
            );
        });
    });

    describe('destroy', () => {
        it('sends a DELETE request to the joined resource path', async () => {
            const { client, resource } = createResource();

            await resource.destroy('w1');

            const call = client.calls.at(0);

            expect(call?.method).toBe('DELETE');
            expect(call?.path).toBe('widgets/w1');
        });

        it('resolves with no value', async () => {
            const { resource } = createResource();

            await expect(resource.destroy('w1')).resolves.toBeUndefined();
        });

        it('passes through the abort signal', async () => {
            const { client, resource } = createResource();
            const controller = new AbortController();

            await resource.destroy('w1', { signal: controller.signal });

            expect(client.calls.at(0)?.options?.signal).toBe(controller.signal);
        });
    });
});
