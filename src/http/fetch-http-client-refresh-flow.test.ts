/**
 * Tests for a 401 that arrives after another request's refresh has landed,
 * through a handler that skips the refresh for a superseded session token.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import { createBearerTokenInterceptor } from './bearer-token-interceptor';
import { FetchHttpClient } from './fetch-http-client';
import type { HttpRequest, UnauthorizedHandler } from './http-client';
import { HttpError } from './http-error';
import { TokenRefreshCoordinator } from './token-refresh-coordinator';

/** The fetch call signature, so mock.calls carries a typed tuple. */
type FetchArgs = [input: Request | string | URL, init?: RequestInit];

/** A typed fetch stub. */
type FetchStub = ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>>;

/** A session and the fake server it talks to, wired into one client. */
interface Harness {
    /** The client under test. */
    readonly client: FetchHttpClient;

    /** The fake server's fetch. */
    readonly fetchFn: FetchStub;

    /** The refresher behind the coordinator. */
    readonly refresher: ReturnType<typeof vi.fn<() => Promise<boolean>>>;

    /** The unauthorized handler implementing the stale-token policy. */
    readonly onUnauthorized: ReturnType<typeof vi.fn<UnauthorizedHandler>>;

    /**
     * Hold the response to the next request to a path until released.
     *
     * @returns a function releasing the held response
     */
    hold(path: string): () => void;

    /**
     * Sign the session out, leaving no current token.
     */
    signOut(): void;

    /**
     * Read the authorization header sent on every fetch, in call order.
     */
    sent(): (string | undefined)[];
}

/**
 * Read the authorization header from a fetch init.
 */
function authorizationOf(init: RequestInit | undefined): string | undefined {
    return ((init?.headers ?? {}) as Record<string, string>)['authorization'];
}

/**
 * Wire a session whose refreshes rotate A1 to A2 and so on, a server that
 * accepts only the latest issued token, and a handler that retries without
 * refreshing when the failed request carried a token the session has since
 * replaced and a current token exists.
 *
 * @param initial - the session's token before any refresh, or null
 * @param superseded - tokens the session already replaced
 */
function createHarness(initial: string | null, superseded: readonly string[] = []): Harness {
    const replaced = new Set(superseded);
    const holds = new Map<string, Promise<void>>();
    let token = initial;
    let accepted: string | null = null;

    const refresher = vi.fn((): Promise<boolean> => {
        if (token === null) {
            return Promise.resolve(false);
        }

        replaced.add(token);
        token = `A${String(Number(token.slice(1)) + 1)}`;
        accepted = token;

        return Promise.resolve(true);
    });
    const coordinator = new TokenRefreshCoordinator({ refresh: refresher });

    /**
     * Read the session token a failed request carried, if it sent a bearer.
     */
    const bearerOf = (request: HttpRequest): string | null => {
        const authorization = request.headers['authorization'] ?? '';

        return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
    };

    const onUnauthorized = vi.fn<UnauthorizedHandler>(request => {
        const bearer = bearerOf(request);

        if (token !== null && bearer !== null && replaced.has(bearer)) {
            return Promise.resolve(true);
        }

        return coordinator.refresh();
    });

    const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>(async (input, init) => {
        const path = new URL(String(input)).pathname;
        const authorization = authorizationOf(init);
        const status = accepted !== null && authorization === `Bearer ${accepted}` ? 200 : 401;
        const held = holds.get(path);

        holds.delete(path);
        await held;

        return status === 200 ? Response.json({ path }) : new Response('', { status });
    });

    const client = new FetchHttpClient({
        baseUrl: 'https://api.example.com',
        fetchFn,
        requestInterceptors: [createBearerTokenInterceptor({ getAccessToken: () => token })],
        onUnauthorized,
    });

    return {
        client,
        fetchFn,
        refresher,
        onUnauthorized,
        hold: path => {
            let release!: () => void;

            holds.set(
                path,
                new Promise<void>(resolve => {
                    release = resolve;
                }),
            );

            return release;
        },
        signOut: () => {
            token = null;
        },
        sent: () => fetchFn.mock.calls.map(([, init]) => authorizationOf(init)),
    };
}

/**
 * Let every pending promise continuation run.
 */
function flush(): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, 0);
    });
}

/**
 * Await a request expected to reject with an HTTP status.
 */
async function rejectedStatus(promise: Promise<unknown>): Promise<number> {
    const error = await promise.catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(HttpError);

    return (error as HttpError).status;
}

describe('FetchHttpClient - a 401 after a settled refresh', () => {
    it('retries a request that carried the superseded token without refreshing again', async () => {
        const harness = createHarness('A1');
        const release = harness.hold('/x');

        const x = harness.client.get('/x');

        await flush();
        await expect(harness.client.get('/y')).resolves.toStrictEqual({ path: '/y' });

        release();

        await expect(x).resolves.toStrictEqual({ path: '/x' });
        expect(harness.refresher).toHaveBeenCalledOnce();
        expect(harness.onUnauthorized.mock.calls.map(([request]) => request.url)).toStrictEqual([
            'https://api.example.com/y',
            'https://api.example.com/x',
        ]);
        expect(harness.onUnauthorized.mock.calls[1]?.[0].headers['authorization']).toBe('Bearer A1');
        expect(harness.sent()).toStrictEqual(['Bearer A1', 'Bearer A1', 'Bearer A2', 'Bearer A2']);
    });

    it('refreshes when the session has no current token by the time the 401 lands', async () => {
        const harness = createHarness('A1');
        const release = harness.hold('/x');

        const x = harness.client.get('/x');

        await flush();
        await harness.client.get('/y');
        harness.signOut();
        release();

        expect(await rejectedStatus(x)).toBe(401);
        expect(harness.refresher).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['an explicit bearer that is not a superseded session token', 'A1', { Authorization: 'Bearer other' }],
        ['an explicit non-bearer authorization', 'A1', { Authorization: 'Basic x' }],
        ['no authorization at all', null, {}],
    ])('refreshes for a request sent with %s', async (_case, initial, headers) => {
        const harness = createHarness(initial);

        expect(await rejectedStatus(harness.client.get('/x', { headers }))).toBe(401);
        expect(harness.onUnauthorized).toHaveBeenCalledOnce();
        expect(harness.refresher).toHaveBeenCalledOnce();
    });

    it('retries an explicit superseded bearer once without refreshing, then rejects', async () => {
        const harness = createHarness('A2', ['A1']);

        expect(await rejectedStatus(harness.client.get('/x', { headers: { Authorization: 'Bearer A1' } }))).toBe(401);
        expect(harness.fetchFn).toHaveBeenCalledTimes(2);
        expect(harness.sent()).toStrictEqual(['Bearer A1', 'Bearer A1']);
        expect(harness.refresher).not.toHaveBeenCalled();
    });
});
