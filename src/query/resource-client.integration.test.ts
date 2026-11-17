/**
 * Integration tests for ResourceClient over FetchHttpClient, against wire
 * fixtures shaped like laravel-api-toolkit responses.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { FetchHttpClient } from '../http/fetch-http-client';
import { QueryTooExpensiveError } from '../http/http-error';
import { ApiQuery } from './api-query';
import type { RawRecord } from './envelope';
import { ResourceClient } from './resource-client';

/** The API base URL the client is bound to. */
const BASE_URL = 'https://api.test/v1';

/** Toolkit cursors: URL-safe, unpadded base64 of the cursor parameters. */
const CURSORS = [
    'eyJpZCI6MiwiX3BvaW50c1RvTmV4dEl0ZW1zIjp0cnVlfQ',
    'eyJpZCI6NCwiX3BvaW50c1RvTmV4dEl0ZW1zIjp0cnVlfQ',
] as const;

/** A fake transport and the client and resource bound to it. */
interface Wire {
    /** The URL of every request sent, in order. */
    readonly urls: string[];

    /** The resource client under test. */
    readonly widgets: ResourceClient<RawRecord>;
}

/**
 * Bind a widgets resource to a FetchHttpClient whose fetch answers each request
 * with the next queued status and body.
 */
function wire(responses: ReadonlyArray<readonly [number, unknown]>): Wire {
    const urls: string[] = [];
    const queue = [...responses];

    /** Record the request URL and answer with the next queued response. */
    const fetchFn = (input: Request | string | URL): Promise<Response> => {
        const [status, body] = queue.shift() ?? [500, null];

        urls.push(String(input));

        return Promise.resolve(
            new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
        );
    };
    const client = new FetchHttpClient({ baseUrl: BASE_URL, fetchFn });

    return { urls, widgets: new ResourceClient({ client, path: 'widgets', map: raw => raw }) };
}

/**
 * Build a cursor page envelope whose next link carries `next`, encoded as the
 * toolkit encodes it, or no next link when `next` is null.
 */
function cursorPage(id: number, next: string | null): unknown {
    return {
        data: [{ id }],
        meta: { continue: next !== null },
        links: {
            self: `${BASE_URL}/widgets?limit=2&pagination=cursor`,
            prev: null,
            next: next === null ? null : `${BASE_URL}/widgets?limit=2&cursor=${next}&pagination=cursor`,
        },
    };
}

/**
 * Read the decoded query entries of a request URL.
 */
function entries(url: string | undefined): Array<[string, string]> {
    return [...new URL(url ?? '').searchParams];
}

describe('ResourceClient over FetchHttpClient', () => {
    it('sends every query parameter so it parses back to the built values', async () => {
        const { urls, widgets } = wire([[200, { data: [] }]]);
        const query = ApiQuery.create()
            .where('name', 'R&D + 50% #1 café')
            .whereIn('code', ['a=b&c', 'x'])
            .search('a=b&c café')
            .fieldsFor('user', ['id', 'name'])
            .aggregatesFor('user', ['posts_count'])
            .orderBy('name', 'desc')
            .withTrashed();

        await widgets.list(query);

        expect(entries(urls[0])).toStrictEqual(
            Object.entries(query.toQueryParameters()).map(([key, value]) => [key, String(value)]),
        );
    });

    it('walks cursor pages with the server cursor unchanged until no next page remains', async () => {
        const { urls, widgets } = wire([
            [200, cursorPage(1, CURSORS[0])],
            [200, cursorPage(3, CURSORS[1])],
            [200, cursorPage(5, null)],
        ]);
        const first = ApiQuery.create().limit(2).useCursorPagination();
        const ids: unknown[] = [];
        let next: string | null = null;

        do {
            const result = await widgets.list(next === null ? first : first.cursor(next));

            ids.push(...result.items.map(item => item['id']));
            next = result.nextCursor;
        } while (next !== null);

        expect(ids).toStrictEqual([1, 3, 5]);
        expect(urls.map(url => new URL(url).searchParams.getAll('cursor'))).toStrictEqual([
            [],
            [CURSORS[0]],
            [CURSORS[1]],
        ]);
    });

    it('decodes and re-encodes an opaque cursor carrying reserved characters', async () => {
        const { urls, widgets } = wire([
            [200, cursorPage(1, 'a%2Bb%2Fc%3D%3D')],
            [200, cursorPage(3, null)],
        ]);
        const first = ApiQuery.create().useCursorPagination();
        const { nextCursor } = await widgets.list(first);

        await widgets.list(first.cursor(nextCursor ?? ''));

        expect(nextCursor).toBe('a+b/c==');
        expect(urls[1]).toBe(`${BASE_URL}/widgets?cursor=a%2Bb%2Fc%3D%3D&pagination=cursor`);
    });

    it('omits a parameter an explicit undefined option overrides', async () => {
        const { urls, widgets } = wire([[200, { data: [] }]]);

        await widgets.list(ApiQuery.create().page(2).limit(5), { query: { page: undefined } });

        expect(urls).toStrictEqual([`${BASE_URL}/widgets?limit=5`]);
    });

    it('rejects a query over a cost cap with the cap details', async () => {
        const meta = {
            parameter: 'filters',
            pointer: '/$or/posts/$and/tags',
            reason: 'max_depth',
            limit: 3,
            actual: 4,
        };
        const { widgets } = wire([
            [
                422,
                {
                    error: {
                        status: 422,
                        code: 10201,
                        title: 'Query Too Expensive',
                        detail: 'The query exceeds a limit on how much work a single request may ask for, please narrow it and try again',
                        meta,
                    },
                },
            ],
        ]);

        const listing = widgets.list();

        await expect(listing).rejects.toBeInstanceOf(QueryTooExpensiveError);
        await expect(listing).rejects.toHaveProperty('meta', meta);
    });
});
