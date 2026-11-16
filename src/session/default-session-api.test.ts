/**
 * Unit tests for the default session API gateway.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import { FetchHttpClient } from '../http/fetch-http-client';
import type { HttpClient, HttpRequestOptions } from '../http/http-client';
import { HttpError, NetworkError } from '../http/http-error';
import type { DefaultSessionApiOptions } from './default-session-api';
import { createDefaultSessionApi } from './default-session-api';
import type { SessionApi } from './session-api';
import { SessionError } from './session-error';
import type { SessionUser } from './session-user';

/** The shape of a single call recorded by {@link FakeHttpClient}. */
interface RecordedCall {
    /** The HTTP method. */
    readonly method: string;

    /** The request path. */
    readonly path: string;

    /** The request body. */
    readonly body: unknown;

    /** The request options. */
    readonly options: HttpRequestOptions | undefined;
}

/** A queued response payload. */
interface QueuedValue {
    /** The payload a call resolves with. */
    readonly value: unknown;
}

/** A queued failure. */
interface QueuedError {
    /** The error a call rejects with. */
    readonly error: unknown;
}

/** Credentials signing in with a phone number. */
interface PhoneCredentials {
    /** The phone number. */
    readonly phone: string;
}

/** A user with a role. */
interface AdminUser extends SessionUser {
    /** The user's role. */
    readonly role: string;
}

/**
 * An in-memory {@link HttpClient} fake that records every call and replays
 * queued response payloads (or errors) in order.
 */
class FakeHttpClient implements HttpClient {
    /** Every call made, in order. */
    readonly calls: RecordedCall[] = [];

    /** The queued responses. */
    readonly #queue: Array<QueuedValue | QueuedError> = [];

    /**
     * Queue a response payload for the next call.
     *
     * @param value - the payload the next call resolves with
     */
    queueResponse(value: unknown): void {
        this.#queue.push({ value });
    }

    /**
     * Queue a failure for the next call.
     *
     * @param error - the error the next call rejects with
     */
    queueError(error: unknown): void {
        this.#queue.push({ error });
    }

    /**
     * Record a GET.
     *
     * @param path - the request path
     * @param options - the request options
     * @returns the next queued outcome
     */
    get<T>(path: string, options?: HttpRequestOptions): Promise<T> {
        return this.#consume('GET', path, undefined, options);
    }

    /**
     * Record a POST.
     *
     * @param path - the request path
     * @param body - the request body
     * @param options - the request options
     * @returns the next queued outcome
     */
    post<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
        return this.#consume('POST', path, body, options);
    }

    /**
     * Record a PUT.
     *
     * @param path - the request path
     * @param body - the request body
     * @param options - the request options
     * @returns the next queued outcome
     */
    put<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
        return this.#consume('PUT', path, body, options);
    }

    /**
     * Record a PATCH.
     *
     * @param path - the request path
     * @param body - the request body
     * @param options - the request options
     * @returns the next queued outcome
     */
    patch<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
        return this.#consume('PATCH', path, body, options);
    }

    /**
     * Record a DELETE.
     *
     * @param path - the request path
     * @param options - the request options
     * @returns the next queued outcome
     */
    delete<T>(path: string, options?: HttpRequestOptions): Promise<T> {
        return this.#consume('DELETE', path, undefined, options);
    }

    /**
     * Record a download.
     *
     * @param path - the request path
     * @param options - the request options
     * @returns the next queued outcome
     */
    download(path: string, options?: HttpRequestOptions): Promise<Blob> {
        return this.#consume('DOWNLOAD', path, undefined, options);
    }

    /**
     * Record a call and settle it with the next queued outcome.
     *
     * @param method - the HTTP method
     * @param path - the request path
     * @param body - the request body
     * @param options - the request options
     * @returns the next queued outcome
     */
    #consume<T>(method: string, path: string, body: unknown, options: HttpRequestOptions | undefined): Promise<T> {
        this.calls.push({ method, path, body, options });

        const next = this.#queue.shift();

        if (next !== undefined && 'error' in next) {
            return Promise.reject(next.error);
        }

        return Promise.resolve(next?.value as T);
    }
}

/**
 * Build a `Record<string, unknown>` from an array of `[key, value]` pairs.
 *
 * Keeps snake_case wire-field names out of object-literal key positions so
 * naming-convention lint rules never see them.
 *
 * @param entries - key-value pairs for the record
 * @returns a plain `Record<string, unknown>`
 */
function wire(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
    return Object.fromEntries(entries);
}

const NOW = 1_700_000_000_000;
const CREDENTIALS = { email: 'alice@example.com', password: 'secret' };
const DEVICE = { uuid: 'device-uuid', os: 'macOS' };
const COOKIE = { headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include' };
const SIGN_IN = { retryOnUnauthorized: false };
const QUIET = { retryOnUnauthorized: false, notifyOnError: false };
const COOKIE_QUIET = { ...COOKIE, ...QUIET };

/**
 * Build a documented session response body.
 *
 * @param overrides - fields replacing the defaults
 * @returns the response body
 */
function sessionBody(overrides: ReadonlyArray<readonly [string, unknown]> = []): Record<string, unknown> {
    return wire([['access_token', 'access'], ['expires_in', 900], ['refresh_token', 'refresh'], ...overrides]);
}

/**
 * Build a documented pending response body.
 *
 * @returns the response body
 */
function pendingBody(): Record<string, unknown> {
    return wire([
        ['pending_credential', 'pending'],
        ['requires', ['mfa', 7, 'principal']],
    ]);
}

/**
 * Build a gateway over the fake with a fixed clock.
 *
 * @param http - the fake HTTP client
 * @param options - further gateway options
 * @returns the gateway
 */
function gateway(http: HttpClient, options: DefaultSessionApiOptions = {}): SessionApi {
    return createDefaultSessionApi(http, { now: () => NOW, ...options });
}

/**
 * Build a user response wrapped in a data envelope.
 *
 * @returns the response body
 */
function userEnvelope(): Record<string, unknown> {
    return {
        data: wire([
            ['id', 'u1'],
            ['first_name', 'Alice'],
            ['last_name', 'Smith'],
            ['email', 'alice@example.com'],
        ]),
    };
}

describe('createDefaultSessionApi', () => {
    describe('login', () => {
        it('posts the credentials and platform to auth/sign-in', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(sessionBody());

            await gateway(http).login(CREDENTIALS, DEVICE);

            expect(http.calls).toStrictEqual([
                {
                    method: 'POST',
                    path: 'auth/sign-in',
                    body: { ...CREDENTIALS, platform: 'macOS' },
                    options: SIGN_IN,
                },
            ]);
        });

        it('maps the documented response, computing the expiry from expires_in', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(sessionBody());

            await expect(gateway(http).login(CREDENTIALS, DEVICE)).resolves.toStrictEqual({
                kind: 'authenticated',
                tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAtEpochMs: NOW + 900_000 },
            });
        });

        it('tolerates a data envelope around the response', async () => {
            const http = new FakeHttpClient();
            http.queueResponse({ data: sessionBody() });

            await expect(gateway(http).login(CREDENTIALS, DEVICE)).resolves.toStrictEqual({
                kind: 'authenticated',
                tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAtEpochMs: NOW + 900_000 },
            });
        });

        it('defaults the clock to the current time', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(sessionBody());
            const before = Date.now();

            const result = await createDefaultSessionApi(http).login(CREDENTIALS, DEVICE);
            const expiresAt = result.kind === 'authenticated' ? result.tokens.expiresAtEpochMs : null;

            expect(expiresAt).toBeGreaterThanOrEqual(before + 900_000);
            expect(expiresAt).toBeLessThanOrEqual(Date.now() + 900_000);
        });

        it('maps a pending response onto interactionRequired with the string requirements', async () => {
            const http = new FakeHttpClient();
            http.queueResponse({ data: wire([['status', 'pending'], ...Object.entries(pendingBody())]) });

            await expect(gateway(http).login(CREDENTIALS, DEVICE)).resolves.toStrictEqual({
                kind: 'interactionRequired',
                pending: { credential: 'pending', requires: ['mfa', 'principal'] },
            });
        });

        it('maps a pending response without requirements to an empty list', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(wire([['pending_credential', 'pending']]));

            await expect(gateway(http).login(CREDENTIALS, DEVICE)).resolves.toStrictEqual({
                kind: 'interactionRequired',
                pending: { credential: 'pending', requires: [] },
            });
        });

        it('maps a missing refresh token and expiry to null', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(wire([['access_token', 'access']]));

            await expect(gateway(http).login(CREDENTIALS, DEVICE)).resolves.toStrictEqual({
                kind: 'authenticated',
                tokens: { accessToken: 'access', refreshToken: null, expiresAtEpochMs: null },
            });
        });

        it('maps a null refresh token and expiry to null', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(
                sessionBody([
                    ['refresh_token', null],
                    ['expires_in', null],
                ]),
            );

            await expect(gateway(http).login(CREDENTIALS, DEVICE)).resolves.toStrictEqual({
                kind: 'authenticated',
                tokens: { accessToken: 'access', refreshToken: null, expiresAtEpochMs: null },
            });
        });

        it.each([
            ['a non-record body', 'bad'],
            ['a null body', null],
            ['a missing access token', wire([['expires_in', 900]])],
            ['an empty access token', sessionBody([['access_token', '']])],
            ['a non-string access token', sessionBody([['access_token', 42]])],
            ['a string expiry', sessionBody([['expires_in', '900']])],
            ['a zero expiry', sessionBody([['expires_in', 0]])],
            ['a negative expiry', sessionBody([['expires_in', -1]])],
            ['a non-string refresh token', sessionBody([['refresh_token', 42]])],
            ['a non-string pending credential', wire([['pending_credential', 42]])],
        ])('throws a SessionError for %s', async (_label, body) => {
            const http = new FakeHttpClient();
            http.queueResponse(body);

            const error: unknown = await gateway(http)
                .login(CREDENTIALS, DEVICE)
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(SessionError);
            expect(error).toHaveProperty('message', 'The session response did not match the expected shape.');
        });

        it('accepts a one-second expiry', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(sessionBody([['expires_in', 1]]));

            await expect(gateway(http).login(CREDENTIALS, DEVICE)).resolves.toStrictEqual({
                kind: 'authenticated',
                tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAtEpochMs: NOW + 1000 },
            });
        });

        it('propagates a failed sign-in request', async () => {
            const http = new FakeHttpClient();
            const failure = new HttpError(401, 'Unauthorized');
            http.queueError(failure);

            await expect(gateway(http).login(CREDENTIALS, DEVICE)).rejects.toBe(failure);
        });

        it('never triggers the unauthorized handler, so a refused sign-in is sent once', async () => {
            const fetchFn = vi.fn<typeof fetch>(() =>
                Promise.resolve(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })),
            );
            const onUnauthorized = vi.fn(() => Promise.resolve(true));
            const http = new FetchHttpClient({ baseUrl: 'https://api.example.com/', fetchFn, onUnauthorized });

            await expect(gateway(http, { transport: 'cookie' }).login(CREDENTIALS, DEVICE)).rejects.toBeInstanceOf(
                HttpError,
            );
            expect(onUnauthorized).not.toHaveBeenCalled();
            expect(fetchFn).toHaveBeenCalledTimes(1);
            expect(fetchFn.mock.calls[0]?.[1]?.method).toBe('POST');
        });

        it('sends cookie credentials and drops a body refresh token in cookie transport', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(sessionBody());

            const result = await gateway(http, { transport: 'cookie' }).login(CREDENTIALS, DEVICE);

            expect(http.calls[0]?.options).toStrictEqual({ ...COOKIE, ...SIGN_IN });
            expect(result).toStrictEqual({
                kind: 'authenticated',
                tokens: { accessToken: 'access', refreshToken: null, expiresAtEpochMs: NOW + 900_000 },
            });
        });
    });

    describe('refresh', () => {
        it('posts the refresh token in the body to auth/refresh, quietly', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(sessionBody());

            await expect(gateway(http).refresh('held')).resolves.toStrictEqual({
                kind: 'refreshed',
                tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAtEpochMs: NOW + 900_000 },
            });
            expect(http.calls).toStrictEqual([
                { method: 'POST', path: 'auth/refresh', body: wire([['refresh_token', 'held']]), options: QUIET },
            ]);
        });

        it('rejects without a request when body transport holds no refresh token', async () => {
            const http = new FakeHttpClient();

            const result = await gateway(http).refresh(null);

            expect(http.calls).toStrictEqual([]);
            expect(result.kind).toBe('rejected');
            expect(result).toHaveProperty('error', expect.any(SessionError));
            expect(result).toHaveProperty('error.message', 'No refresh token is held to refresh with.');
        });

        it('sends credentials, the cross-site header and no body token in cookie transport', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(
                wire([
                    ['access_token', 'access'],
                    ['expires_in', 60],
                ]),
            );

            await expect(gateway(http, { transport: 'cookie' }).refresh(null)).resolves.toStrictEqual({
                kind: 'refreshed',
                tokens: { accessToken: 'access', refreshToken: null, expiresAtEpochMs: NOW + 60_000 },
            });
            expect(http.calls).toStrictEqual([
                { method: 'POST', path: 'auth/refresh', body: undefined, options: COOKIE_QUIET },
            ]);
        });

        it('never sends a held refresh token in cookie transport', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(sessionBody());

            await gateway(http, { transport: 'cookie' }).refresh('stale');

            expect(http.calls[0]?.body).toBeUndefined();
        });

        it('maps a pending response onto interactionRequired', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(pendingBody());

            await expect(gateway(http).refresh('held')).resolves.toStrictEqual({
                kind: 'interactionRequired',
                pending: { credential: 'pending', requires: ['mfa', 'principal'] },
            });
        });

        it.each([
            [new HttpError(401, 'Unauthorized'), 'rejected'],
            [new HttpError(429, 'Too Many Attempts'), 'retryable'],
            [new HttpError(503, 'Unavailable'), 'retryable'],
            [new NetworkError('offline'), 'retryable'],
            [new HttpError(403, 'Forbidden'), 'failed'],
            [new HttpError(422, 'Unprocessable'), 'failed'],
        ])('classifies %o as %s', async (failure, kind) => {
            const http = new FakeHttpClient();
            http.queueError(failure);

            await expect(gateway(http).refresh('held')).resolves.toStrictEqual({ kind, error: failure });
        });

        it('classifies a malformed 2xx response as failed', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(wire([['token', 'legacy']]));

            const result = await gateway(http).refresh('held');

            expect(result.kind).toBe('failed');
            expect(result).toHaveProperty('error', expect.any(SessionError));
        });
    });

    describe('logout', () => {
        it('posts the refresh token to auth/logout, quietly', async () => {
            const http = new FakeHttpClient();

            await gateway(http).logout('held');

            expect(http.calls).toStrictEqual([
                { method: 'POST', path: 'auth/logout', body: wire([['refresh_token', 'held']]), options: QUIET },
            ]);
        });

        it('sends no body when no refresh token is held', async () => {
            const http = new FakeHttpClient();

            await gateway(http).logout(null);

            expect(http.calls).toStrictEqual([
                { method: 'POST', path: 'auth/logout', body: undefined, options: QUIET },
            ]);
        });

        it('sends credentials, the cross-site header and no body token in cookie transport', async () => {
            const http = new FakeHttpClient();

            await gateway(http, { transport: 'cookie' }).logout('stale');

            expect(http.calls).toStrictEqual([
                { method: 'POST', path: 'auth/logout', body: undefined, options: COOKIE_QUIET },
            ]);
        });

        it('propagates a failed sign-out request', async () => {
            const http = new FakeHttpClient();
            const failure = new NetworkError('offline');
            http.queueError(failure);

            await expect(gateway(http).logout('held')).rejects.toBe(failure);
        });
    });

    describe('paths and sign-in body', () => {
        it('reaches custom paths', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(sessionBody());
            http.queueResponse(sessionBody());
            http.queueResponse(undefined);
            http.queueResponse(userEnvelope());

            const api = gateway(http, { paths: { login: 'login', refresh: 'renew', logout: 'leave', user: 'me' } });

            await api.login(CREDENTIALS, DEVICE);
            await api.refresh('held');
            await api.logout('held');
            await api.currentUser();

            expect(http.calls.map(call => [call.method, call.path])).toStrictEqual([
                ['POST', 'login'],
                ['POST', 'renew'],
                ['POST', 'leave'],
                ['GET', 'me'],
            ]);
        });

        it('keeps the default for a path left out', async () => {
            const http = new FakeHttpClient();

            await gateway(http, { paths: { login: 'login' } }).logout(null);

            expect(http.calls[0]?.path).toBe('auth/logout');
        });

        it('builds the sign-in body with a custom builder', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(sessionBody());

            await createDefaultSessionApi<PhoneCredentials>(http, {
                loginBody: (credentials, device) => ({ ...credentials, device: device.uuid }),
            }).login({ phone: '+441234' }, DEVICE);

            expect(http.calls[0]?.body).toStrictEqual({ phone: '+441234', device: 'device-uuid' });
        });
    });

    describe('currentUser', () => {
        it('gets users/self and maps the enveloped user', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(userEnvelope());

            await expect(gateway(http).currentUser()).resolves.toStrictEqual({
                id: 'u1',
                email: 'alice@example.com',
                name: 'Alice Smith',
                permissions: [],
            });
            expect(http.calls).toStrictEqual([
                { method: 'GET', path: 'users/self', body: undefined, options: undefined },
            ]);
        });

        it('maps an unenveloped user', async () => {
            const http = new FakeHttpClient();
            http.queueResponse(wire([['id', 7]]));

            await expect(gateway(http).currentUser()).resolves.toStrictEqual({
                id: 7,
                email: null,
                name: null,
                permissions: [],
            });
        });

        it('keeps only the string permissions', async () => {
            const http = new FakeHttpClient();
            http.queueResponse({
                data: wire([
                    ['id', 'u1'],
                    ['permissions', ['users.view', 3, 'users.edit']],
                ]),
            });

            await expect(gateway(http).currentUser()).resolves.toHaveProperty('permissions', [
                'users.view',
                'users.edit',
            ]);
        });

        it('collapses a non-array permissions field to an empty list', async () => {
            const http = new FakeHttpClient();
            http.queueResponse({
                data: wire([
                    ['id', 'u1'],
                    ['permissions', 'users.view'],
                ]),
            });

            await expect(gateway(http).currentUser()).resolves.toHaveProperty('permissions', []);
        });

        it('maps a non-string email to null', async () => {
            const http = new FakeHttpClient();
            http.queueResponse({
                data: wire([
                    ['id', 'u1'],
                    ['email', 42],
                ]),
            });

            await expect(gateway(http).currentUser()).resolves.toHaveProperty('email', null);
        });

        it.each([
            [[['first_name', 'Alice']], 'Alice'],
            [[['last_name', 'Smith']], 'Smith'],
            [
                [
                    ['first_name', 42],
                    ['last_name', 'Smith'],
                ],
                'Smith',
            ],
        ] as const)('composes the name from %j', async (parts, name) => {
            const http = new FakeHttpClient();
            http.queueResponse({ data: wire([['id', 'u1'], ...parts]) });

            await expect(gateway(http).currentUser()).resolves.toHaveProperty('name', name);
        });

        it.each([
            ['a non-record body', 'bad'],
            ['a null body', null],
            ['a missing identifier', { data: wire([['first_name', 'Alice']]) }],
            ['a boolean identifier', { data: wire([['id', true]]) }],
        ])('throws a SessionError for %s', async (_label, body) => {
            const http = new FakeHttpClient();
            http.queueResponse(body);

            const error: unknown = await gateway(http)
                .currentUser()
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(SessionError);
            expect(error).toHaveProperty('message', 'The user response did not match the expected shape.');
        });

        it('maps the unwrapped user through a custom mapping', async () => {
            const http = new FakeHttpClient();
            const seen: unknown[] = [];
            http.queueResponse({ data: { role: 'raw' } });

            const user = await createDefaultSessionApi(http, {
                mapUser: (payload): AdminUser => {
                    seen.push(payload);

                    return { id: 'mapped', email: null, name: null, permissions: [], role: 'admin' };
                },
            }).currentUser();

            expect(seen).toStrictEqual([{ role: 'raw' }]);
            expect(user).toStrictEqual({ id: 'mapped', email: null, name: null, permissions: [], role: 'admin' });
        });

        it('requires a mapping for a richer user type', () => {
            // @ts-expect-error a richer user type cannot fall back to the default mapping
            const api: SessionApi<AdminUser> = createDefaultSessionApi(new FakeHttpClient());

            expect(api).toBeDefined();
        });
    });
});
