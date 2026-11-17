/**
 * Integration tests for the authentication chain: the session core signing in
 * and refreshing through the wired HTTP client, against the fake authentication
 * server behind a fetch that speaks its wire format.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBearerTokenInterceptor } from '../http/bearer-token-interceptor';
import type { HttpClient, HttpRequest, RequestInterceptor, UnauthorizedHandler } from '../http/http-client';
import { CancelledError, HttpError } from '../http/http-error';
import { TokenRefreshCoordinator } from '../http/token-refresh-coordinator';
import type { ErrorReporter } from '../reporting/error-reporter';
import { createDefaultSessionApi } from '../session/default-session-api';
import { KeyValueSessionPersistence } from '../session/key-value-session-persistence';
import type { PasswordCredentials, SessionDevice } from '../session/session-api';
import type { SessionCoreContext } from '../session/session-core';
import {
    createInitialSessionState,
    loginWithCredentials,
    logoutSession,
    refreshSession,
    sessionIdentity,
} from '../session/session-core';
import type { LoginOutcome, RefreshOutcome } from '../session/session-outcomes';
import type { SessionState } from '../session/session-state';
import type { SessionTokens } from '../session/session-tokens';
import type { FakeAuthOperation } from '../session/test-support/fake-auth-server';
import { FakeAuthServer } from '../session/test-support/fake-auth-server';
import { MemoryStorage } from '../storage/memory-storage';
import { installReporting, resetFoundationServices } from './services';
import { wireHttpClient } from './wire-http-client';

/** The fetch call signature, so mock.calls carries a typed tuple. */
type FetchArgs = [input: Request | string | URL, init?: RequestInit];

/** The body a protected resource answers with. */
interface ResourceBody {
    /** The requested path. */
    readonly path: string;

    /** The server session the request was served for. */
    readonly session: string;
}

/** Per-request options of a protected-resource request. */
interface ResourceOptions {
    /** The caller's own abort signal. */
    readonly signal?: AbortSignal;

    /** Whether the request also carries the current session's signal. */
    readonly bound?: boolean;
}

/** An application wired over the fake server: session, client and handler. */
interface Harness {
    /** The fake authentication server. */
    readonly server: FakeAuthServer;

    /** The session state. */
    readonly state: SessionState;

    /** The fetch the client sends through. */
    readonly fetchFn: ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>>;

    /** The reporter the default response-error handler reports to. */
    readonly reporter: ErrorReporter;

    /** Every refresh outcome the handler received, in order. */
    readonly outcomes: RefreshOutcome[];

    /** Called as each refresh settles, before the handler sees its outcome. */
    onRefreshed: () => void;

    /** Called just before the handler approves a retry. */
    onApproval: () => void;

    /**
     * Cancel the current session's requests, then sign in.
     */
    signIn(credentials: PasswordCredentials): Promise<LoginOutcome>;

    /**
     * Cancel the current session's requests, then sign out.
     */
    signOut(): Promise<void>;

    /**
     * Request a protected resource.
     */
    get(path: string, options?: ResourceOptions): Promise<ResourceBody>;

    /**
     * Hold the response to the next request to a path until released; the
     * server answers it as it stands on release.
     *
     * @returns the release
     */
    hold(path: string): () => void;

    /**
     * Answer the next request to a path with a bare status.
     */
    failNext(path: string, status: number): void;

    /**
     * Move the clock on.
     */
    advance(ms: number): void;

    /**
     * Read the authorization header sent with each request to a path.
     */
    sent(path: string): (string | undefined)[];

    /**
     * Count the requests of one kind the server served.
     */
    served(operation: FakeAuthOperation): number;
}

const ALICE: PasswordCredentials = { email: 'alice@example.com', password: 'secret' };
const BOB: PasswordCredentials = { email: 'bob@example.com', password: 'secret' };
const DEVICE: SessionDevice = { uuid: 'device', os: 'iOS' };
const ACCESS_TTL_MS = 900_000;

/**
 * Read the bearer token an authorization header carries, if any.
 */
function bearerOf(authorization: string | undefined): string | null {
    return authorization?.startsWith('Bearer ') === true ? authorization.slice('Bearer '.length) : null;
}

/**
 * Read the authorization header from a fetch init.
 */
function authorizationOf(init: RequestInit | undefined): string | undefined {
    return ((init?.headers ?? {}) as Record<string, string>)['authorization'];
}

/**
 * Read the refresh token a request body carries, if any.
 */
function refreshTokenOf(body: Record<string, unknown>): string | null {
    const token = body['refresh_token'];

    return typeof token === 'string' ? token : null;
}

/**
 * Answer with a failure's status, or 500 for anything that is not an HTTP
 * error.
 */
function failureResponse(error: unknown): Response {
    return new Response('', { status: error instanceof HttpError ? error.status : 500 });
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

/** One request as the fake fetch hands it to a route. */
interface AuthCall {
    /** The server's gateway, authenticated by the request's bearer token. */
    readonly gateway: ReturnType<FakeAuthServer['api']>;

    /** The bearer token the request carried, or null. */
    readonly bearer: string | null;

    /** The parsed JSON request body, or an empty record. */
    readonly body: Record<string, unknown>;
}

/** A fetch over the fake server, with hooks to hold or fail a request. */
interface AuthFetch {
    /** The fetch. */
    readonly fetchFn: ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>>;

    /**
     * Hold the response to the next request to a path until released.
     *
     * @returns the release
     */
    hold(path: string): () => void;

    /**
     * Answer the next request to a path with a bare status.
     */
    failNext(path: string, status: number): void;
}

/**
 * Build the session routes over the fake server, answering in the wire format
 * the default session API reads.
 */
function authRoutes(now: () => number): Readonly<Record<string, (call: AuthCall) => Promise<Response>>> {
    /**
     * Answer with a token set in the wire format.
     */
    const tokens = (issued: SessionTokens): Response =>
        Response.json({
            access_token: issued.accessToken,
            expires_in: ((issued.expiresAtEpochMs ?? now()) - now()) / 1000,
            refresh_token: issued.refreshToken,
        });

    return {
        '/auth/sign-in': async ({ gateway, body }) => {
            const credentials = { email: String(body['email']), password: String(body['password']) };
            const result = await gateway.login(credentials, DEVICE, refreshTokenOf(body));

            return result.kind === 'authenticated' ? tokens(result.tokens) : failureResponse(null);
        },
        '/auth/refresh': async ({ gateway, body }) => {
            const result = await gateway.refresh(refreshTokenOf(body));

            return result.kind === 'refreshed'
                ? tokens(result.tokens)
                : failureResponse('error' in result ? result.error : null);
        },
        '/auth/logout': async ({ gateway, bearer, body }) => {
            await gateway.logout({
                accessToken: bearer ?? '',
                refreshToken: refreshTokenOf(body),
                expiresAtEpochMs: null,
            });

            return new Response(null, { status: 204 });
        },
        '/users/self': async ({ gateway }) => {
            const user = await gateway.currentUser();

            return Response.json({ data: { id: user.id, email: user.email } });
        },
    };
}

/**
 * Build a fetch that serves the session endpoints through the fake server and
 * any other path as a resource of the session the bearer token belongs to. A
 * held response is decided as the server stands on release.
 */
function createAuthFetch(server: FakeAuthServer, now: () => number): AuthFetch {
    const routes = authRoutes(now);
    const holds = new Map<string, Promise<void>>();
    const failures = new Map<string, number>();

    /**
     * Answer a request through its route, or as a protected resource.
     */
    const serve = (path: string, init: RequestInit | undefined): Promise<Response> => {
        const bearer = bearerOf(authorizationOf(init));
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        const route = routes[path];

        if (route !== undefined) {
            return route({ gateway: server.api({ accessToken: () => bearer }), bearer, body });
        }

        const session = server.sessionOf(bearer);

        return Promise.resolve(
            session === undefined ? new Response('', { status: 401 }) : Response.json({ path, session: session.id }),
        );
    };

    const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>(async (input, init) => {
        const path = new URL(String(input)).pathname;
        const held = holds.get(path);

        holds.delete(path);
        await held;

        const failure = failures.get(path);

        if (failure !== undefined) {
            failures.delete(path);

            return new Response('', { status: failure });
        }

        try {
            return await serve(path, init);
        } catch (error) {
            return failureResponse(error);
        }
    });

    return {
        fetchFn,
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
        failNext: (path, status) => {
            failures.set(path, status);
        },
    };
}

/**
 * Wire the session core, the default session API and the HTTP client over a
 * fake server.
 *
 * The unauthorized handler follows the stale-token policy, scoped to a session:
 * a request sent with a token of a session since replaced is refused outright,
 * one sent with a token its own session has since rotated is retried without a
 * refresh, and any other is refreshed, retrying only while the session it
 * started on is still held. Every request may also carry its session's abort
 * signal, which a sign-in or sign-out aborts before it starts, cancelling a
 * retry approved just before.
 */
function createHarness(): Harness {
    let now = 1_000_000;
    let lineages = 0;
    let scope = new AbortController();
    const server = new FakeAuthServer({ now: () => now, accessTtlMs: ACCESS_TTL_MS });
    const state = createInitialSessionState();
    const issuedBy = new Map<string, object>();
    const outcomes: RefreshOutcome[] = [];
    const reporter: ErrorReporter = { captureError: vi.fn(), captureMessage: vi.fn(), setUser: vi.fn() };

    const { fetchFn, hold, failNext } = createAuthFetch(server, () => now);

    const attachBearer = createBearerTokenInterceptor({ getAccessToken: () => state.accessToken });

    /**
     * Attach the session's bearer token, recording the session it was attached
     * for; an explicit authorization is left in place and not recorded.
     */
    const interceptor: RequestInterceptor = async request => {
        const sent = await attachBearer(request);
        const token = state.accessToken;
        const identity = sessionIdentity(state);

        if (sent !== request && token !== null && identity !== null) {
            issuedBy.set(token, identity);
        }

        return sent;
    };

    let context: SessionCoreContext | null = null;
    const coordinator = new TokenRefreshCoordinator<RefreshOutcome>({
        refresh: async () => {
            const outcome = await refreshSession(state, contextOf());

            harness.onRefreshed();

            return outcome;
        },
    });

    const harness: Harness = {
        server,
        state,
        fetchFn,
        reporter,
        outcomes,
        onRefreshed: () => undefined,
        onApproval: () => undefined,
        signIn: credentials => {
            renewScope();

            return loginWithCredentials(state, contextOf(), credentials);
        },
        signOut: () => {
            renewScope();

            return logoutSession(state, contextOf());
        },
        get: (path, options = {}) => {
            const signals = [options.signal, options.bound === true ? scope.signal : undefined].filter(
                (signal): signal is AbortSignal => signal !== undefined,
            );

            return http.get<ResourceBody>(path, signals.length === 0 ? {} : { signal: AbortSignal.any(signals) });
        },
        hold,
        failNext,
        advance: ms => {
            now += ms;
        },
        sent: path =>
            fetchFn.mock.calls
                .filter(([input]) => new URL(String(input)).pathname === path)
                .map(([, init]) => authorizationOf(init)),
        served: operation => server.requests.filter(request => request.operation === operation).length,
    };

    /**
     * Decide whether a request that received a 401 is retried.
     */
    const onUnauthorized: UnauthorizedHandler = async (request: HttpRequest) => {
        const bearer = bearerOf(request.headers['authorization']);
        const owner = bearer === null ? undefined : issuedBy.get(bearer);
        const current = sessionIdentity(state);

        if (owner !== undefined && owner !== current) {
            return false;
        }

        if (owner === undefined || bearer === state.accessToken) {
            const outcome = await coordinator.refresh();

            outcomes.push(outcome);

            if (outcome.kind !== 'refreshed' || sessionIdentity(state) !== current) {
                return false;
            }
        }

        harness.onApproval();

        return true;
    };

    const http: HttpClient = wireHttpClient({
        config: {
            api: { baseUrl: 'https://api.example.com', timeout: 0 },
            app: { name: 'Test App', environment: 'production', version: '1.0.0' },
            featureFlags: { flags: {} },
            locales: { default: 'en-US', enabled: ['en-US'], supported: { 'en-US': { direction: 'ltr' } } },
        },
        fetchFn,
        contributions: { requestInterceptors: [interceptor], onUnauthorized, responseErrorHandlers: [] },
    });

    /**
     * Abort the current session's requests and open a new scope.
     */
    function renewScope(): void {
        scope.abort();
        scope = new AbortController();
    }

    /**
     * Resolve the session context, built once the client exists.
     */
    function contextOf(): SessionCoreContext {
        context ??= {
            persistence: new KeyValueSessionPersistence(new MemoryStorage()),
            api: createDefaultSessionApi(http, { now: () => now }),
            device: () => DEVICE,
            createLineage: () => {
                lineages += 1;

                return `lineage-${String(lineages)}`;
            },
        };

        return context;
    }

    installReporting(reporter);

    return harness;
}

afterEach(() => {
    resetFoundationServices();
});

describe('session and HTTP client wiring', () => {
    it('refreshes an expired access token once and retries with the rotated token', async () => {
        const harness = createHarness();

        await expect(harness.signIn(ALICE)).resolves.toStrictEqual({ kind: 'authenticated' });

        const first = harness.state.accessToken;
        const session = harness.server.sessionOf(first)?.id;

        await expect(harness.get('/items')).resolves.toStrictEqual({ path: '/items', session });

        harness.advance(ACCESS_TTL_MS);

        await expect(harness.get('/items')).resolves.toStrictEqual({ path: '/items', session });

        const rotated = harness.state.accessToken;

        expect(rotated).not.toBe(first);
        expect(harness.sent('/items')).toStrictEqual([`Bearer ${first}`, `Bearer ${first}`, `Bearer ${rotated}`]);
        expect(harness.served('refresh')).toBe(1);
        expect(harness.outcomes).toStrictEqual([{ kind: 'refreshed' }]);
        expect(harness.reporter.captureError).not.toHaveBeenCalled();
    });

    it('retries a delayed 401 from a token its session rotated, without refreshing again', async () => {
        const harness = createHarness();

        await harness.signIn(ALICE);

        const first = harness.state.accessToken;

        harness.advance(ACCESS_TTL_MS);

        const release = harness.hold('/x');
        const x = harness.get('/x');

        await flush();
        await harness.get('/y');
        release();

        await expect(x).resolves.toStrictEqual({ path: '/x', session: harness.server.issuerOf(first)?.id });
        expect(harness.sent('/x')).toStrictEqual([`Bearer ${first}`, `Bearer ${harness.state.accessToken}`]);
        expect(harness.served('refresh')).toBe(1);
    });

    it('shares one refresh between concurrent 401s, an abort cancelling only its own wait', async () => {
        const harness = createHarness();
        const caller = new AbortController();

        await harness.signIn(ALICE);

        const first = harness.state.accessToken;

        harness.advance(ACCESS_TTL_MS);

        const release = harness.hold('/auth/refresh');
        const a = harness.get('/a');
        const b = harness.get('/b', { signal: caller.signal });

        await flush();
        caller.abort();

        await expect(b).rejects.toBeInstanceOf(CancelledError);

        release();

        await expect(a).resolves.toMatchObject({ path: '/a' });
        expect(harness.sent('/auth/refresh')).toHaveLength(1);
        expect(harness.sent('/a')).toStrictEqual([`Bearer ${first}`, `Bearer ${harness.state.accessToken}`]);
        expect(harness.sent('/b')).toStrictEqual([`Bearer ${first}`]);
    });

    it('lets the 401 stand and clears the session when the refresh is refused', async () => {
        const harness = createHarness();

        await harness.signIn(ALICE);

        const first = harness.state.accessToken;

        await harness.server
            .api({ accessToken: () => null })
            .logout({ accessToken: '', refreshToken: harness.state.refreshToken, expiresAtEpochMs: null });

        expect(await rejectedStatus(harness.get('/items'))).toBe(401);
        expect(harness.outcomes).toMatchObject([{ kind: 'rejected' }]);
        expect(harness.state.accessToken).toBeNull();
        expect(harness.sent('/items')).toStrictEqual([`Bearer ${first}`]);
    });

    it('lets the 401 stand and keeps the session when the refresh fails transiently', async () => {
        const harness = createHarness();

        await harness.signIn(ALICE);

        const first = harness.state.accessToken;

        harness.advance(ACCESS_TTL_MS);
        harness.failNext('/auth/refresh', 503);

        expect(await rejectedStatus(harness.get('/items'))).toBe(401);
        expect(harness.outcomes).toMatchObject([{ kind: 'retryable' }]);
        expect(harness.state.accessToken).toBe(first);
        expect(harness.sent('/items')).toStrictEqual([`Bearer ${first}`]);
        expect(harness.served('refresh')).toBe(0);
    });

    it.each([
        ['an unbound request lets its 401 stand', false, HttpError],
        ['a bound request is cancelled', true, CancelledError],
    ])('refuses the retry when a sign-out lands during the refresh: %s', async (_case, bound, rejection) => {
        const harness = createHarness();

        await harness.signIn(ALICE);

        const first = harness.state.accessToken;

        harness.advance(ACCESS_TTL_MS);

        const release = harness.hold('/auth/refresh');
        const x = harness.get('/x', { bound });

        await flush();

        const signingOut = harness.signOut();

        release();

        await expect(x).rejects.toBeInstanceOf(rejection);
        await signingOut;
        expect(harness.outcomes).toStrictEqual([{ kind: 'superseded' }]);
        expect(harness.sent('/x')).toStrictEqual([`Bearer ${first}`]);
        expect(harness.sent('/auth/logout')).toStrictEqual([`Bearer ${first}`]);
    });

    it.each([
        ['the same user signing in again', (harness: Harness) => harness.signIn(ALICE)],
        [
            'another user signing in after a sign-out',
            async (harness: Harness) => {
                await harness.signOut();
                await harness.signIn(BOB);
            },
        ],
    ])('refuses a stale 401 from a session replaced by %s', async (_case, replace) => {
        const harness = createHarness();

        await harness.signIn(ALICE);

        const first = harness.state.accessToken;
        const release = harness.hold('/x');
        const x = harness.get('/x');

        await flush();
        await replace(harness);

        const second = harness.state.accessToken;

        release();

        expect(second).not.toBeNull();
        expect(second).not.toBe(first);
        expect(await rejectedStatus(x)).toBe(401);
        expect(harness.served('refresh')).toBe(0);
        expect(harness.sent('/x')).toStrictEqual([`Bearer ${first}`]);
        expect(harness.state.accessToken).toBe(second);
    });

    it('refuses the retry when the session is cleared as its refresh settles', async () => {
        const harness = createHarness();
        let signingOut: Promise<void> = Promise.resolve();

        await harness.signIn(ALICE);

        const first = harness.state.accessToken;

        harness.advance(ACCESS_TTL_MS);
        harness.onRefreshed = () => {
            signingOut = harness.signOut();
        };

        expect(await rejectedStatus(harness.get('/x'))).toBe(401);
        await signingOut;
        expect(harness.outcomes).toStrictEqual([{ kind: 'refreshed' }]);
        expect(harness.sent('/x')).toStrictEqual([`Bearer ${first}`]);
    });

    it('cancels a bound retry approved just before the session is replaced', async () => {
        const harness = createHarness();
        let signingOut: Promise<void> = Promise.resolve();

        await harness.signIn(ALICE);

        const first = harness.state.accessToken;

        harness.advance(ACCESS_TTL_MS);
        harness.onApproval = () => {
            queueMicrotask(() => {
                signingOut = harness.signOut();
            });
        };

        await expect(harness.get('/x', { bound: true })).rejects.toBeInstanceOf(CancelledError);
        await signingOut;
        expect(harness.outcomes).toStrictEqual([{ kind: 'refreshed' }]);
        expect(harness.sent('/x')).toStrictEqual([`Bearer ${first}`]);
        expect(harness.state.accessToken).toBeNull();
    });
});
