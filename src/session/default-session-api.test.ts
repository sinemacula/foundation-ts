/**
 * Unit tests for the default session API gateway.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import type { HttpClient, HttpRequestOptions } from '../http/http-client';
import { createDefaultSessionApi } from './default-session-api';
import type { SessionUser } from './session-user';

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
 * naming-convention lint rules never see them.
 *
 * @param entries - key-value pairs for the record
 * @returns a plain `Record<string, unknown>`
 */
function wire(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
    return Object.fromEntries(entries);
}

/** A valid session envelope as returned by the API. */
function sessionEnvelope(): Record<string, unknown> {
    return {
        data: wire([
            ['token', 'tok-abc'],
            ['refresh_token', 'ref-abc'],
            ['expires_at', '2026-12-31 23:59:59'],
        ]),
    };
}

/** A valid user envelope as returned by the API. */
function userEnvelope(permissions?: unknown): Record<string, unknown> {
    const entries: Array<readonly [string, unknown]> = [
        ['id', 'u1'],
        ['first_name', 'Alice'],
        ['last_name', 'Smith'],
        ['email', 'alice@example.com'],
    ];

    if (permissions !== undefined) {
        entries.push(['permissions', permissions]);
    }

    return { data: wire(entries) };
}

const CREDENTIALS = { email: 'alice@example.com', password: 'secret' };
const DEVICE = { uuid: 'device-uuid', os: 'WEB' };

/**
 * The epoch-millisecond instant for the UTC wire timestamp 2026-12-31 23:59:59.
 */
const SESSION_EXPIRY_EPOCH_MS = 1_798_761_599_000;

describe('createDefaultSessionApi', () => {
    describe('login', () => {
        it('maps a valid response onto SessionTokens', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(sessionEnvelope());

            const tokens = await createDefaultSessionApi(fake).login(CREDENTIALS, DEVICE);

            expect(tokens).toStrictEqual({
                accessToken: 'tok-abc',
                refreshToken: 'ref-abc',
                expiresAtEpochMs: SESSION_EXPIRY_EPOCH_MS,
            });
        });

        it('parses the expiry as a UTC instant', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({
                data: wire([
                    ['token', 't'],
                    ['refresh_token', 'r'],
                    ['expires_at', '2026-01-01 00:00:00'],
                ]),
            });

            const tokens = await createDefaultSessionApi(fake).login(CREDENTIALS, DEVICE);

            expect(tokens.expiresAtEpochMs).toBe(1_767_225_600_000);
            expect(tokens.expiresAtEpochMs).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
        });

        it('parses a summer expiry as UTC regardless of the local offset', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({
                data: wire([
                    ['token', 't'],
                    ['refresh_token', 'r'],
                    ['expires_at', '2026-07-01 12:00:00'],
                ]),
            });

            const tokens = await createDefaultSessionApi(fake).login(CREDENTIALS, DEVICE);

            expect(tokens.expiresAtEpochMs).toBe(1_782_907_200_000);
            expect(tokens.expiresAtEpochMs).toBe(Date.UTC(2026, 6, 1, 12, 0, 0));
        });

        it('normalises an unparseable expiry to null', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({
                data: wire([
                    ['token', 't'],
                    ['refresh_token', 'r'],
                    ['expires_at', 'not-a-timestamp'],
                ]),
            });

            const tokens = await createDefaultSessionApi(fake).login(CREDENTIALS, DEVICE);

            expect(tokens.expiresAtEpochMs).toBeNull();
        });

        it('posts to auth with the supplied credentials and device fields', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(sessionEnvelope());

            await createDefaultSessionApi(fake).login(CREDENTIALS, DEVICE);

            const call = fake.calls.at(0);

            expect(call?.method).toBe('POST');
            expect(call?.path).toBe('auth');
            expect(call?.body).toStrictEqual({
                email: 'alice@example.com',
                password: 'secret',
                uuid: 'device-uuid',
                os: 'WEB',
            });
            expect(call?.options).toBeUndefined();
        });

        it('posts to a custom session endpoint', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(sessionEnvelope());

            await createDefaultSessionApi(fake, { endpoints: { session: 'sessions' } }).login(CREDENTIALS, DEVICE);

            expect(fake.calls.at(0)?.path).toBe('sessions');
        });

        it('throws when the response has no data envelope', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse('not-a-record');

            await expect(createDefaultSessionApi(fake).login(CREDENTIALS, DEVICE)).rejects.toThrow(
                'The response did not match the expected envelope shape.',
            );
        });

        it('throws when the data envelope is not a record', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({ data: 'not-a-record' });

            await expect(createDefaultSessionApi(fake).login(CREDENTIALS, DEVICE)).rejects.toThrow(
                'The response did not match the expected envelope shape.',
            );
        });

        it('throws when data.token is missing', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({
                data: wire([
                    ['refresh_token', 'r'],
                    ['expires_at', '2026-01-01 00:00:00'],
                ]),
            });

            await expect(createDefaultSessionApi(fake).login(CREDENTIALS, DEVICE)).rejects.toThrow(
                'The session response did not match the expected shape.',
            );
        });

        it('throws when data.refresh_token is missing', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({
                data: wire([
                    ['token', 't'],
                    ['expires_at', '2026-01-01 00:00:00'],
                ]),
            });

            await expect(createDefaultSessionApi(fake).login(CREDENTIALS, DEVICE)).rejects.toThrow(
                'The session response did not match the expected shape.',
            );
        });

        it('throws when data.expires_at is missing', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({
                data: wire([
                    ['token', 't'],
                    ['refresh_token', 'r'],
                ]),
            });

            await expect(createDefaultSessionApi(fake).login(CREDENTIALS, DEVICE)).rejects.toThrow(
                'The session response did not match the expected shape.',
            );
        });
    });

    describe('refresh', () => {
        it('maps a valid response onto SessionTokens', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(sessionEnvelope());

            const tokens = await createDefaultSessionApi(fake).refresh('my-refresh-token');

            expect(tokens).toStrictEqual({
                accessToken: 'tok-abc',
                refreshToken: 'ref-abc',
                expiresAtEpochMs: SESSION_EXPIRY_EPOCH_MS,
            });
        });

        it('patches auth with the refresh token', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(sessionEnvelope());

            await createDefaultSessionApi(fake).refresh('my-refresh-token');

            const call = fake.calls.at(0);

            expect(call?.method).toBe('PATCH');
            expect(call?.path).toBe('auth');
            expect(call?.body).toStrictEqual(wire([['refresh_token', 'my-refresh-token']]));
        });

        it('disables error notification and unauthorized retry on the refresh request', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(sessionEnvelope());

            await createDefaultSessionApi(fake).refresh('my-refresh-token');

            expect(fake.calls.at(0)?.options).toStrictEqual({
                notifyOnError: false,
                retryOnUnauthorized: false,
            });
        });

        it('patches a custom session endpoint', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(sessionEnvelope());

            await createDefaultSessionApi(fake, { endpoints: { session: 'sessions' } }).refresh('tok');

            expect(fake.calls.at(0)?.path).toBe('sessions');
        });

        it('throws when the response envelope is malformed', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(null);

            await expect(createDefaultSessionApi(fake).refresh('tok')).rejects.toThrow(
                'The response did not match the expected envelope shape.',
            );
        });

        it('throws when data.token is not a string', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({
                data: wire([
                    ['token', 42],
                    ['refresh_token', 'r'],
                    ['expires_at', '2026-01-01 00:00:00'],
                ]),
            });

            await expect(createDefaultSessionApi(fake).refresh('tok')).rejects.toThrow(
                'The session response did not match the expected shape.',
            );
        });
    });

    describe('logout', () => {
        it('deletes auth', async () => {
            const fake = new FakeHttpClient();

            await createDefaultSessionApi(fake).logout();

            const call = fake.calls.at(0);

            expect(call?.method).toBe('DELETE');
            expect(call?.path).toBe('auth');
        });

        it('deletes a custom session endpoint', async () => {
            const fake = new FakeHttpClient();

            await createDefaultSessionApi(fake, { endpoints: { session: 'sessions' } }).logout();

            expect(fake.calls.at(0)?.path).toBe('sessions');
        });
    });

    describe('currentUser', () => {
        it('maps a valid response onto SessionUser', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(userEnvelope());

            const user = await createDefaultSessionApi(fake).currentUser();

            expect(user).toStrictEqual({
                id: 'u1',
                email: 'alice@example.com',
                name: 'Alice Smith',
                permissions: [],
            });
        });

        it('gets users/self', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(userEnvelope());

            await createDefaultSessionApi(fake).currentUser();

            const call = fake.calls.at(0);

            expect(call?.method).toBe('GET');
            expect(call?.path).toBe('users/self');
        });

        it('gets a custom user endpoint', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(userEnvelope());

            await createDefaultSessionApi(fake, { endpoints: { user: 'me' } }).currentUser();

            expect(fake.calls.at(0)?.path).toBe('me');
        });

        it('accepts a numeric identifier', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({ data: wire([['id', 7]]) });

            const user = await createDefaultSessionApi(fake).currentUser();

            expect(user.id).toBe(7);
        });

        it('maps the permissions array when present', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(userEnvelope(['users.view', 'billing.view']));

            const user = await createDefaultSessionApi(fake).currentUser();

            expect(user.permissions).toStrictEqual(['users.view', 'billing.view']);
        });

        it('filters out non-string entries from a mixed-type permissions array', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(userEnvelope(['users.view', 42, null, 'billing.view']));

            const user = await createDefaultSessionApi(fake).currentUser();

            expect(user.permissions).toStrictEqual(['users.view', 'billing.view']);
        });

        it('collapses a non-array permissions field to an empty array', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(userEnvelope('not-an-array'));

            const user = await createDefaultSessionApi(fake).currentUser();

            expect(user.permissions).toStrictEqual([]);
        });

        it('maps a missing email to null', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({ data: wire([['id', 'u1']]) });

            const user = await createDefaultSessionApi(fake).currentUser();

            expect(user.email).toBeNull();
        });

        it('maps a non-string email to null', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({
                data: wire([
                    ['id', 'u1'],
                    ['email', 42],
                ]),
            });

            const user = await createDefaultSessionApi(fake).currentUser();

            expect(user.email).toBeNull();
        });

        it('maps the name from first_name alone', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({
                data: wire([
                    ['id', 'u1'],
                    ['first_name', 'Alice'],
                ]),
            });

            const user = await createDefaultSessionApi(fake).currentUser();

            expect(user.name).toBe('Alice');
        });

        it('maps the name from last_name alone', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({
                data: wire([
                    ['id', 'u1'],
                    ['last_name', 'Smith'],
                ]),
            });

            const user = await createDefaultSessionApi(fake).currentUser();

            expect(user.name).toBe('Smith');
        });

        it('ignores a non-string name part', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({
                data: wire([
                    ['id', 'u1'],
                    ['first_name', 42],
                    ['last_name', 'Smith'],
                ]),
            });

            const user = await createDefaultSessionApi(fake).currentUser();

            expect(user.name).toBe('Smith');
        });

        it('maps a missing name pair to null', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({ data: wire([['id', 'u1']]) });

            const user = await createDefaultSessionApi(fake).currentUser();

            expect(user.name).toBeNull();
        });

        it('throws when the response has no data envelope', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse('bad');

            await expect(createDefaultSessionApi(fake).currentUser()).rejects.toThrow(
                'The response did not match the expected envelope shape.',
            );
        });

        it('throws when the identifier is missing', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({ data: wire([['first_name', 'Alice']]) });

            await expect(createDefaultSessionApi(fake).currentUser()).rejects.toThrow(
                'The user response did not match the expected shape.',
            );
        });

        it('throws when the identifier is neither a string nor a number', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse({ data: wire([['id', true]]) });

            await expect(createDefaultSessionApi(fake).currentUser()).rejects.toThrow(
                'The user response did not match the expected shape.',
            );
        });
    });

    describe('options', () => {
        it('passes the raw wire value to a custom parseTimestamp and uses its result', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(sessionEnvelope());
            const seen: string[] = [];

            const tokens = await createDefaultSessionApi(fake, {
                parseTimestamp: value => {
                    seen.push(value);

                    return 12_345;
                },
            }).login(CREDENTIALS, DEVICE);

            expect(seen).toStrictEqual(['2026-12-31 23:59:59']);
            expect(tokens.expiresAtEpochMs).toBe(12_345);
        });

        it('normalises the expiry to null when a custom parseTimestamp returns null', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(sessionEnvelope());

            const tokens = await createDefaultSessionApi(fake, { parseTimestamp: () => null }).refresh('tok');

            expect(tokens.expiresAtEpochMs).toBeNull();
        });

        it('maps a session through a custom unwrap', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(
                wire([
                    ['token', 'flat-token'],
                    ['refresh_token', 'flat-refresh'],
                    ['expires_at', '2026-01-01 00:00:00'],
                ]),
            );

            const tokens = await createDefaultSessionApi(fake, { unwrap: payload => payload }).login(
                CREDENTIALS,
                DEVICE,
            );

            expect(tokens).toStrictEqual({
                accessToken: 'flat-token',
                refreshToken: 'flat-refresh',
                expiresAtEpochMs: 1_767_225_600_000,
            });
        });

        it('throws the session shape error when a custom unwrap yields a non-record', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(sessionEnvelope());

            await expect(
                createDefaultSessionApi(fake, { unwrap: () => 'not-a-record' }).login(CREDENTIALS, DEVICE),
            ).rejects.toThrow('The session response did not match the expected shape.');
        });

        it('maps a user through a custom unwrap', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(
                wire([
                    ['id', 'u1'],
                    ['first_name', 'Alice'],
                    ['last_name', 'Smith'],
                    ['email', 'alice@example.com'],
                ]),
            );

            const user = await createDefaultSessionApi(fake, { unwrap: payload => payload }).currentUser();

            expect(user).toStrictEqual({
                id: 'u1',
                email: 'alice@example.com',
                name: 'Alice Smith',
                permissions: [],
            });
        });

        it('throws the user shape error when a custom unwrap yields a non-record', async () => {
            const fake = new FakeHttpClient();
            fake.queueResponse(userEnvelope());

            await expect(createDefaultSessionApi(fake, { unwrap: () => 'not-a-record' }).currentUser()).rejects.toThrow(
                'The user response did not match the expected shape.',
            );
        });

        it('passes the unwrapped payload to a custom mapUser and returns its result', async () => {
            interface AdminUser extends SessionUser {
                readonly role: string;
            }

            const fake = new FakeHttpClient();
            fake.queueResponse(userEnvelope());
            const seen: unknown[] = [];

            const user = await createDefaultSessionApi<AdminUser>(fake, {
                mapUser: payload => {
                    seen.push(payload);

                    return { id: 'mapped', email: null, name: null, permissions: [], role: 'admin' };
                },
            }).currentUser();

            expect(seen).toStrictEqual([
                wire([
                    ['id', 'u1'],
                    ['first_name', 'Alice'],
                    ['last_name', 'Smith'],
                    ['email', 'alice@example.com'],
                ]),
            ]);
            expect(user).toStrictEqual({ id: 'mapped', email: null, name: null, permissions: [], role: 'admin' });
        });
    });
});
