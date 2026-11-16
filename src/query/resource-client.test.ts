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
    /** The widget identifier. */
    readonly id: string;

    /** The widget display name. */
    readonly name: string;
}

/** The shape of a single call recorded by {@link FakeHttpClient}. */
interface RecordedCall {
    /** The HTTP method called. */
    readonly method: string;

    /** The request path. */
    readonly path: string;

    /** The request body, if any. */
    readonly body: unknown;

    /** The request options passed through. */
    readonly options: HttpRequestOptions | undefined;
}

/** The fake transport and the resource client bound to it. */
interface ResourceFixture {
    /** The recording fake transport. */
    readonly client: FakeHttpClient;

    /** The resource client under test. */
    readonly resource: ResourceClient<Widget>;
}

/**
 * An in-memory {@link HttpClient} fake that records every call and replays
 * queued response payloads in order.
 */
class FakeHttpClient implements HttpClient {
    /** Every call made, in order. */
    readonly calls: RecordedCall[] = [];

    /** The queued response payloads, consumed in order. */
    readonly #queue: unknown[] = [];

    /**
     * Queue a response payload for the next call.
     *
     * @param value - the payload the next call resolves with
     */
    queueResponse(value: unknown): void {
        this.#queue.push(value);
    }

    /**
     * Record a GET call.
     *
     * @param path - the request path
     * @param options - the request options
     * @returns the next queued payload
     */
    get<T>(path: string, options?: HttpRequestOptions): Promise<T> {
        return this.#consume('GET', path, undefined, options);
    }

    /**
     * Record a POST call.
     *
     * @param path - the request path
     * @param body - the request body
     * @param options - the request options
     * @returns the next queued payload
     */
    post<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
        return this.#consume('POST', path, body, options);
    }

    /**
     * Record a PUT call.
     *
     * @param path - the request path
     * @param body - the request body
     * @param options - the request options
     * @returns the next queued payload
     */
    put<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
        return this.#consume('PUT', path, body, options);
    }

    /**
     * Record a PATCH call.
     *
     * @param path - the request path
     * @param body - the request body
     * @param options - the request options
     * @returns the next queued payload
     */
    patch<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
        return this.#consume('PATCH', path, body, options);
    }

    /**
     * Record a DELETE call.
     *
     * @param path - the request path
     * @param options - the request options
     * @returns the next queued payload
     */
    delete<T>(path: string, options?: HttpRequestOptions): Promise<T> {
        return this.#consume('DELETE', path, undefined, options);
    }

    /**
     * Record a download call.
     *
     * @param path - the request path
     * @param options - the request options
     * @returns the next queued payload
     */
    download(path: string, options?: HttpRequestOptions): Promise<Blob> {
        return this.#consume('DOWNLOAD', path, undefined, options);
    }

    /**
     * Record a call and resolve with the next queued payload.
     *
     * @param method - the HTTP method called
     * @param path - the request path
     * @param body - the request body, if any
     * @param options - the request options
     * @returns the next queued payload
     */
    #consume<T>(method: string, path: string, body: unknown, options: HttpRequestOptions | undefined): Promise<T> {
        this.calls.push({ method, path, body, options });

        return Promise.resolve(this.#queue.shift() as T);
    }
}

/**
 * Build a `Record<string, unknown>` from an array of `[key, value]` pairs.
 *
 * Keeps snake_case wire-field names out of object-literal key positions.
 *
 * @param entries - key-value pairs for the record
 * @returns a plain `Record<string, unknown>`
 */
function wire(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
    return Object.fromEntries(entries);
}

/**
 * Build a raw widget wire record.
 *
 * @param id - the widget id
 * @param name - the widget name
 * @returns the wire record
 */
function widgetRecord(id: string, name: string): Record<string, unknown> {
    return wire([
        ['id', id],
        ['name', name],
    ]);
}

/**
 * Build a valid single-widget envelope.
 *
 * @param id - the widget id
 * @param name - the widget name
 * @returns the envelope payload
 */
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

/**
 * Build a `ResourceClient<Widget>` wired against a fresh `FakeHttpClient`.
 *
 * @param path - the resource collection path
 * @returns the fake client and the resource bound to it
 */
function createResource(path = 'widgets'): ResourceFixture {
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
                meta: { total: 1, count: 1, continue: false },
            });

            const result = await resource.list();

            expect(result.items).toEqual([{ id: 'w1', name: 'Widget One' }]);
            expect(result.meta).toEqual({ mode: 'length-aware', total: 1, count: 1, hasMore: false });
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

        it('trims runs of slashes at the join without touching interior path slashes', async () => {
            const { client, resource } = createResource('v1/widgets//');
            client.queueResponse(widgetEnvelope('w1', 'Widget One'));

            await resource.show('//w1');

            expect(client.calls.at(0)?.path).toBe('v1/widgets/w1');
        });

        it('preserves interior slashes in a nested id', async () => {
            const { client, resource } = createResource();
            client.queueResponse(widgetEnvelope('w1', 'Widget One'));

            await resource.show('w1/notes');

            expect(client.calls.at(0)?.path).toBe('widgets/w1/notes');
        });

        it('merges an ApiQuery into the request options', async () => {
            const { client, resource } = createResource();
            client.queueResponse(widgetEnvelope('w1', 'Widget One'));

            await resource.show('w1', ApiQuery.create().fieldsFor('widget', ['id']).withTrashed());

            expect(client.calls.at(0)?.options?.query).toEqual({ 'fields[widget]': 'id', trashed: 'with' });
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

            await resource.create({ name: 'Widget One' }, undefined, { signal: controller.signal });

            expect(client.calls.at(0)?.options).toEqual({ signal: controller.signal });
        });

        it('shapes the returned record with an ApiQuery, explicit options.query winning on collision', async () => {
            const { client, resource } = createResource();
            client.queueResponse(widgetEnvelope('w1', 'Widget One'));

            await resource.create({ name: 'Widget One' }, ApiQuery.create().fieldsFor('widget', ['id', 'name']).limit(1), {
                query: { limit: 2 },
            });

            expect(client.calls.at(0)?.options?.query).toEqual({ 'fields[widget]': 'id,name', limit: 2 });
        });

        it('sends no options when neither a query nor options are given', async () => {
            const { client, resource } = createResource();
            client.queueResponse(widgetEnvelope('w1', 'Widget One'));

            await resource.create({ name: 'Widget One' });

            expect(client.calls.at(0)?.options).toBeUndefined();
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
            expect(updated).toEqual({ id: 'w1', name: 'Widget One (renamed)' });
        });

        it('shapes the returned record with an ApiQuery', async () => {
            const { client, resource } = createResource();
            client.queueResponse(widgetEnvelope('w1', 'Widget One'));

            await resource.update('w1', { name: 'Widget One' }, ApiQuery.create().fieldsFor('widget', ['id', 'name']));

            expect(client.calls.at(0)?.options?.query).toEqual({ 'fields[widget]': 'id,name' });
        });

        it('resolves undefined when the server answers with no body', async () => {
            const { client, resource } = createResource();
            client.queueResponse(undefined);

            await expect(resource.update('w1', { name: 'Widget One' })).resolves.toBeUndefined();
        });

        it('still rejects a null body as a malformed envelope', async () => {
            const { client, resource } = createResource();
            client.queueResponse(null);

            await expect(resource.update('w1', { name: 'x' })).rejects.toThrow(
                'The response did not match the expected envelope shape.',
            );
        });

        it('passes through request options', async () => {
            const { client, resource } = createResource();
            client.queueResponse(widgetEnvelope('w1', 'Widget One'));
            const controller = new AbortController();

            await resource.update('w1', { name: 'Widget One' }, undefined, { signal: controller.signal });

            expect(client.calls.at(0)?.options).toEqual({ signal: controller.signal });
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
