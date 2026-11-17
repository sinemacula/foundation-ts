/**
 * Pins the rules the fake authentication server applies.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { HttpError } from '../../http/http-error';
import type { SessionApi } from '../session-api';
import type { SessionTokens } from '../session-tokens';
import type { FakeAuthServerOptions } from './fake-auth-server';
import { FakeAuthServer } from './fake-auth-server';

const ALICE = { email: 'alice@example.com', password: 'secret' };
const BOB = { email: 'bob@example.com', password: 'secret' };
const DEVICE = { uuid: 'device', os: 'macOS' };

/** A server, its clock and one context's gateway. */
interface Harness {
    /** The server. */
    readonly server: FakeAuthServer;

    /** The gateway. */
    readonly api: SessionApi;

    /** Move the clock on. */
    readonly advance: (ms: number) => void;

    /** Set the bearer token the gateway's authenticated requests carry. */
    readonly bear: (token: string | null) => void;
}

/**
 * Build a server over a manual clock, with one gateway.
 */
function harness(options: Omit<FakeAuthServerOptions, 'now'> = {}): Harness {
    let now = 1_000_000;
    let bearer: string | null = null;
    const server = new FakeAuthServer({ now: () => now, ...options });

    return {
        server,
        api: server.api({ accessToken: () => bearer }),
        advance: ms => {
            now += ms;
        },
        bear: token => {
            bearer = token;
        },
    };
}

/**
 * Sign in and return the issued tokens.
 */
async function signIn(
    api: SessionApi,
    credentials = ALICE,
    refreshToken: string | null = null,
): Promise<SessionTokens> {
    const result = await api.login(credentials, DEVICE, refreshToken);

    if (result.kind !== 'authenticated') {
        throw new Error('Expected a session.');
    }

    return result.tokens;
}

/**
 * Refresh and return the issued tokens.
 */
async function rotate(api: SessionApi, refreshToken: string | null): Promise<SessionTokens> {
    const result = await api.refresh(refreshToken);

    if (result.kind !== 'refreshed') {
        throw new Error(`Expected a rotation, got ${result.kind}.`);
    }

    return result.tokens;
}

describe('FakeAuthServer', () => {
    it('signs in, issuing a pair that expires after the access lifetime', async () => {
        const { server, api } = harness();

        await expect(signIn(api)).resolves.toStrictEqual({
            accessToken: 'access-s1-3',
            refreshToken: 'refresh-s1-2',
            expiresAtEpochMs: 1_900_000,
        });
        expect(server.sessions()).toStrictEqual([
            { id: 's1', owner: ALICE.email, rotation: 2, previous: null, rotatedAt: null, revoked: null },
        ]);
    });

    it('refuses a wrong password with a 422', async () => {
        const { server, api } = harness();

        await expect(api.login({ ...ALICE, password: 'wrong' }, DEVICE, null)).rejects.toMatchObject({ status: 422 });
        expect(server.sessions()).toStrictEqual([]);
    });

    it('rotates the current token, then answers the previous one inside the grace window', async () => {
        const { server, api, advance } = harness();
        const first = await signIn(api);
        const second = await rotate(api, first.refreshToken);

        advance(29_999);

        await expect(rotate(api, first.refreshToken)).resolves.toHaveProperty('refreshToken', second.refreshToken);
        expect(server.session('s1')).toMatchObject({ rotation: 4, previous: 2, rotatedAt: 1_000_000, revoked: null });
    });

    it.each([
        ['after the grace window', 30_000, {}],
        ['with no grace window', 0, { graceMs: 0 }],
    ])('revokes the session for a replay of the previous token %s', async (_label, wait, options) => {
        const { server, api, advance } = harness(options);
        const first = await signIn(api);
        const second = await rotate(api, first.refreshToken);

        advance(wait);

        const result = await api.refresh(first.refreshToken);

        expect(result).toStrictEqual({ kind: 'rejected', error: expect.any(HttpError) });
        expect(server.session('s1')?.revoked).toBe('rotation_reuse');
        await expect(api.refresh(second.refreshToken)).resolves.toHaveProperty('kind', 'rejected');
    });

    it('revokes the session for a token two rotations old, even inside the grace window', async () => {
        const { server, api } = harness();
        const first = await signIn(api);
        const second = await rotate(api, first.refreshToken);

        await rotate(api, second.refreshToken);
        await api.refresh(first.refreshToken);

        expect(server.session('s1')?.revoked).toBe('rotation_reuse');
    });

    it.each([null, 'unknown', 'refresh-s9-1'])(
        'refuses the refresh credential %j without revoking anything',
        async token => {
            const { server, api } = harness();

            await signIn(api);

            await expect(api.refresh(token)).resolves.toHaveProperty('kind', 'rejected');
            expect(server.session('s1')?.revoked).toBeNull();
        },
    );

    it('supersedes the session whose current token a sign-in of the same identity presents', async () => {
        const { server, api } = harness();
        const first = await signIn(api);

        await signIn(api, ALICE, first.refreshToken);

        expect(server.session('s1')?.revoked).toBe('superseded');
        expect(server.requests.map(request => request.refreshToken)).toStrictEqual([null, first.refreshToken]);
    });

    it.each([
        ['another identity', BOB, false],
        ['a token rotated since', ALICE, true],
    ])('supersedes nothing for %s', async (_label, credentials, rotateFirst) => {
        const { server, api } = harness();
        const first = await signIn(api);

        if (rotateFirst) {
            await rotate(api, first.refreshToken);
        }

        await signIn(api, credentials, first.refreshToken);

        expect(server.session('s1')?.revoked).toBeNull();
    });

    it('signs out by a live bearer token', async () => {
        const { server, api } = harness();
        const tokens = await signIn(api);

        await api.logout({ ...tokens, refreshToken: null });

        expect(server.session('s1')?.revoked).toBe('signed_out');
        expect(server.sessionOf(tokens.accessToken)).toBeUndefined();
        expect(server.issuerOf(tokens.accessToken)).toMatchObject({ id: 's1', revoked: 'signed_out' });
        expect(server.issuerOf(null)).toBeUndefined();
    });

    it('falls back to the refresh credential once the bearer token has expired, even inside the grace window', async () => {
        const { server, api, advance } = harness({ accessTtlMs: 1000 });
        const first = await signIn(api);

        await rotate(api, first.refreshToken);
        advance(1000);
        await api.logout(first);

        expect(server.session('s1')?.revoked).toBe('signed_out');
    });

    it('revokes the session when a sign-out falls back to a replayed refresh token', async () => {
        const { server, api, advance } = harness({ accessTtlMs: 1000 });
        const first = await signIn(api);
        const second = await rotate(api, first.refreshToken);

        await rotate(api, second.refreshToken);
        advance(1000);

        await expect(api.logout(first)).rejects.toMatchObject({ status: 401 });
        expect(server.session('s1')?.revoked).toBe('rotation_reuse');
    });

    it('serves the user of the session the request-time bearer token belongs to', async () => {
        const { api, bear } = harness();
        const tokens = await signIn(api);

        await expect(api.currentUser()).rejects.toMatchObject({ status: 401 });

        bear(tokens.accessToken);

        await expect(api.currentUser()).resolves.toStrictEqual({
            id: ALICE.email,
            email: ALICE.email,
            name: null,
            permissions: [],
        });
    });

    describe('cookie transport', () => {
        it('keeps the refresh token in the shared jar, rotating it there', async () => {
            const { server, api } = harness({ transport: 'cookie' });
            const tokens = await signIn(api);

            expect(tokens.refreshToken).toBeNull();
            expect(server.cookie).toBe('refresh-s1-2');

            await rotate(api, 'ignored');

            expect(server.cookie).toBe('refresh-s1-4');
            expect(server.requests.at(-1)).toStrictEqual({
                operation: 'refresh',
                bearer: null,
                refreshToken: 'refresh-s1-2',
            });
        });

        it('supersedes the session whose cookie a sign-in presents', async () => {
            const { server, api } = harness({ transport: 'cookie' });

            await signIn(api);
            await signIn(api);

            expect(server.session('s1')?.revoked).toBe('superseded');
            expect(server.cookie).toBe('refresh-s4-5');
        });

        it('deletes the cookie when signing out by bearer, leaving the cookie session live', async () => {
            const { server, api } = harness({ transport: 'cookie' });
            const first = await signIn(api, ALICE);
            const second = server.api({ accessToken: () => null });

            await signIn(second, BOB);
            await api.logout(first);

            expect(server.cookie).toBeNull();
            expect(server.sessions().map(session => session.revoked)).toStrictEqual(['signed_out', null]);
        });

        it('falls back to the cookie when the bearer token has expired, revoking the cookie session', async () => {
            const { server, api, advance } = harness({ transport: 'cookie', accessTtlMs: 1000 });
            const first = await signIn(api, ALICE);

            advance(1000);
            await signIn(server.api({ accessToken: () => null }), BOB);
            await api.logout(first);

            expect(server.cookie).toBeNull();
            expect(server.sessions().map(session => session.revoked)).toStrictEqual([null, 'signed_out']);
        });
    });

    it('holds a request until its gate lets it go', async () => {
        let release!: () => void;
        const server = new FakeAuthServer({ now: () => 0 });
        const api = server.api({
            accessToken: () => null,
            before: () =>
                new Promise<void>(resolve => {
                    release = resolve;
                }),
        });

        const login = api.login(ALICE, DEVICE, null);

        await Promise.resolve();

        expect(server.requests).toStrictEqual([]);

        release();
        await login;

        expect(server.requests).toStrictEqual([{ operation: 'login', bearer: null, refreshToken: null }]);
    });
});
