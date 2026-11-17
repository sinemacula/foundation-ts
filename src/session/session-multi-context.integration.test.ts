/**
 * Integration tests for contexts sharing one persisted session against an
 * authentication server that rotates, revokes replays and signs out by cookie.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../storage/memory-storage';
import { InProcessSessionLock } from './in-process-session-lock';
import { KeyValueSessionPersistence } from './key-value-session-persistence';
import type { PasswordCredentials } from './session-api';
import type { SessionCoreContext } from './session-core';
import {
    createInitialSessionState,
    hydrateSession,
    loginWithCredentials,
    logoutSession,
    refreshSession,
    rehydrateSessionUser,
    sessionIdentity,
} from './session-core';
import type { SessionLock } from './session-lock';
import type { SessionState } from './session-state';
import type { FakeAuthOperation, FakeAuthServerOptions } from './test-support/fake-auth-server';
import { FakeAuthServer } from './test-support/fake-auth-server';

const ALICE: PasswordCredentials = { email: 'alice@example.com', password: 'secret' };
const BOB: PasswordCredentials = { email: 'bob@example.com', password: 'secret' };

/**
 * A storage whose next reads or writes can be made to fail.
 */
class FlakyStorage extends MemoryStorage {
    /** How many of the next writes fail. */
    failures = 0;

    /** How many of the next reads fail. */
    readFailures = 0;

    /**
     * Read the value, unless this read is set to fail.
     */
    override get(key: string): string | null {
        if (this.readFailures > 0) {
            this.readFailures -= 1;

            throw new Error('unreadable');
        }

        return super.get(key);
    }

    /**
     * Store the value, unless this write is set to fail.
     */
    override set(key: string, value: string): void {
        if (this.failures > 0) {
            this.failures -= 1;

            throw new Error('quota');
        }

        super.set(key, value);
    }
}

/**
 * A lock whose next task can be held back.
 */
class HoldableLock implements SessionLock {
    /** The gate the next task waits on, or null. */
    gate: Promise<void> | null = null;

    /** The lock the tasks run under. */
    readonly #inner = new InProcessSessionLock();

    /**
     * Run the task once the gate, if any, has opened.
     */
    run<T>(task: () => Promise<T>): Promise<T> {
        const gate = this.gate;

        this.gate = null;

        return this.#inner.run(async () => {
            await gate;

            return task();
        });
    }
}

/** One context: its state, its context and a way to hold its next request. */
interface Tab {
    /** The context's session state. */
    readonly state: SessionState;

    /** The context the transitions run with. */
    readonly context: SessionCoreContext;

    /**
     * Hold the context's next request of the given kind until released.
     *
     * @returns the release
     */
    hold(operation: FakeAuthOperation): () => void;
}

/** Contexts sharing one store, one exchange lock and one server. */
interface World {
    /** The server. */
    readonly server: FakeAuthServer;

    /** The shared storage. */
    readonly storage: FlakyStorage;

    /** The persistence lock every context shares. */
    readonly persistenceLock: HoldableLock;

    /** Move the clock on. */
    readonly advance: (ms: number) => void;

    /** Open a context. */
    readonly tab: () => Tab;
}

/**
 * Build contexts over one store and one server.
 */
function world(options: Omit<FakeAuthServerOptions, 'now'> = {}): World {
    let now = 1_000_000;
    let lineages = 0;
    const server = new FakeAuthServer({ now: () => now, ...options });
    const storage = new FlakyStorage();
    const persistenceLock = new HoldableLock();
    const exchangeLock = new InProcessSessionLock();

    return {
        server,
        storage,
        persistenceLock,
        advance: ms => {
            now += ms;
        },
        tab: () => {
            const state = createInitialSessionState();
            const held = new Map<FakeAuthOperation, Promise<void>>();

            return {
                state,
                context: {
                    api: server.api({
                        accessToken: () => state.accessToken,
                        before: async operation => {
                            const gate = held.get(operation);

                            held.delete(operation);
                            await gate;
                        },
                    }),
                    persistence: new KeyValueSessionPersistence(storage, { lock: persistenceLock }),
                    device: () => ({ uuid: 'device', os: 'macOS' }),
                    createLineage: () => {
                        lineages += 1;

                        return `lineage-${String(lineages)}`;
                    },
                    exchangeLock,
                },
                hold: operation => {
                    let release!: () => void;

                    held.set(
                        operation,
                        new Promise<void>(resolve => {
                            release = resolve;
                        }),
                    );

                    return () => {
                        release();
                    };
                },
            };
        },
    };
}

/** A sign-out queued behind another context's sign-in, whose request is held. */
interface Queued {
    /** The contexts' world. */
    readonly built: World;

    /** The context signing out. */
    readonly a: Tab;

    /** The context signing in. */
    readonly b: Tab;

    /** The sign-in, settling with its outcome or failure. */
    readonly login: Promise<unknown>;

    /** The sign-out. */
    readonly logout: Promise<void>;

    /** Release the sign-in request. */
    readonly release: () => void;
}

/**
 * Sign one context in and bring a second in line with it, both with their user
 * loaded.
 */
async function twoSignedIn(built: World): Promise<readonly [Tab, Tab]> {
    const a = built.tab();
    const b = built.tab();

    await loginWithCredentials(a.state, a.context, ALICE);
    await hydrateSession(b.state, b.context);
    await rehydrateSessionUser(b.state, b.context);

    return [a, b];
}

/**
 * Count the requests of one kind the server served.
 */
function served(server: FakeAuthServer, operation: FakeAuthOperation): number {
    return server.requests.filter(request => request.operation === operation).length;
}

/**
 * Let every queued callback run.
 */
async function flush(): Promise<void> {
    for (let turn = 0; turn < 3; turn += 1) {
        await new Promise<void>(resolve => {
            setTimeout(resolve, 0);
        });
    }
}

describe('contexts sharing a persisted session', () => {
    it.each([
        ['inside the grace window, after one rotation', 10_000, 1],
        ['after the grace window, after one rotation', 31_000, 1],
        ['after two rotations', 31_000, 2],
    ])('take a rotation they missed instead of replaying the spent token %s', async (_label, wait, rotations) => {
        const built = world();
        const [a, b] = await twoSignedIn(built);
        const identity = sessionIdentity(b.state);

        for (let rotation = 0; rotation < rotations; rotation += 1) {
            await expect(refreshSession(a.state, a.context)).resolves.toStrictEqual({ kind: 'refreshed' });
        }

        built.advance(wait);

        await expect(refreshSession(b.state, b.context)).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(served(built.server, 'refresh')).toBe(rotations);
        expect(built.server.session('s1')?.revoked).toBeNull();
        expect(b.state).toStrictEqual(a.state);
        expect(b.state.user).toStrictEqual(a.state.user);
        expect(sessionIdentity(b.state)).toBe(identity);
    });

    it.each([
        ['with the default grace window', {}],
        ['with no grace window', { graceMs: 0 }],
    ])('make one request for concurrent refreshes, both keeping the session, %s', async (_label, options) => {
        const built = world(options);
        const [a, b] = await twoSignedIn(built);

        const results = await Promise.all([refreshSession(a.state, a.context), refreshSession(b.state, b.context)]);

        expect(results).toStrictEqual([{ kind: 'refreshed' }, { kind: 'refreshed' }]);
        expect(served(built.server, 'refresh')).toBe(1);
        expect(built.server.session('s1')?.revoked).toBeNull();
        expect(b.state).toStrictEqual(a.state);
        expect(JSON.parse(built.storage.get('auth.session') ?? 'null')).toMatchObject({ revision: 2 });
    });

    it('leave the newer cookie when one signs in while another signs out', async () => {
        const built = world({ transport: 'cookie' });
        const [a, b] = await twoSignedIn(built);
        const release = a.hold('logout');

        const logout = logoutSession(a.state, a.context);

        await flush();
        const login = loginWithCredentials(b.state, b.context, BOB);

        await flush();
        release();
        await Promise.all([logout, login]);

        expect(built.server.cookie).toBe('refresh-s4-5');
        expect(built.server.sessions().map(session => session.revoked)).toStrictEqual(['signed_out', null]);
        await expect(refreshSession(b.state, b.context)).resolves.toStrictEqual({ kind: 'refreshed' });
    });

    describe('when a sign-out queues behind another context sign-in in cookie transport', () => {
        /**
         * Sign A in, start B signing in as Bob with its request held, then sign
         * A out, its bearer token valid or expired.
         */
        async function queued(expired: boolean): Promise<Queued> {
            const built = world({ transport: 'cookie', accessTtlMs: 60_000 });
            const a = built.tab();
            const b = built.tab();

            await loginWithCredentials(a.state, a.context, ALICE);

            if (expired) {
                built.advance(60_000);
            }

            const release = b.hold('login');
            const login = loginWithCredentials(b.state, b.context, BOB).catch((error: unknown) => error);

            await flush();
            const logout = logoutSession(a.state, a.context);

            await flush();

            return { built, a, b, login, logout, release };
        }

        it.each([
            ['valid', false],
            ['expired', true],
        ])('makes no request once the sign-in persisted, the bearer token %s', async (_label, expired) => {
            const { built, b, login, logout, release } = await queued(expired);

            release();
            await Promise.all([login, logout]);

            expect(served(built.server, 'logout')).toBe(0);
            expect(built.server.cookie).toBe('refresh-s4-5');
            expect(built.server.session('s4')?.revoked).toBeNull();
            await expect(refreshSession(b.state, b.context)).resolves.toStrictEqual({ kind: 'refreshed' });
        });

        it.each([
            ['valid', false],
            ['expired', true],
        ])(
            'makes no request once the sign-in rolled back its unpersisted session, the bearer token %s',
            async (_label, expired) => {
                const { built, b, login, logout, release } = await queued(expired);
                built.storage.failures = 1;

                release();

                await expect(login).resolves.toHaveProperty('message', 'quota');
                await logout;
                expect(b.state.accessToken).toBeNull();
                expect(served(built.server, 'logout')).toBe(0);
                expect(built.server.session('s4')?.revoked).toBeNull();
            },
        );

        it.each([
            ['valid, signs A out and deletes the orphaned cookie', false, ['signed_out', null]],
            ['expired, falls back to the orphaned cookie and revokes its session', true, [null, 'signed_out']],
        ])(
            'proceeds once neither the save nor its rollback could be written; the bearer token %s',
            async (_label, expired, revoked) => {
                const { built, b, login, logout, release } = await queued(expired);
                built.storage.failures = 2;

                release();

                await expect(login).resolves.toHaveProperty('message', 'quota');
                await logout;
                expect(b.state.accessToken).toBeNull();
                expect(served(built.server, 'logout')).toBe(1);
                expect(built.server.cookie).toBeNull();
                expect(built.server.sessions().map(session => session.revoked)).toStrictEqual(revoked);
            },
        );

        it.each([
            ['valid', false],
            ['expired', true],
        ])(
            'leaves a newer sign-in alone when an overtaken one rolls back its unpersisted session, the bearer token %s',
            async (_label, expired) => {
                const { built, b, login, logout, release } = await queued(expired);
                let open!: () => void;
                built.persistenceLock.gate = new Promise<void>(resolve => {
                    open = resolve;
                });

                release();
                await flush();
                const newer = loginWithCredentials(b.state, b.context, BOB);

                built.storage.readFailures = 1;
                open();

                await expect(login).resolves.toHaveProperty('message', 'unreadable');
                await logout;
                await expect(newer).resolves.toStrictEqual({ kind: 'authenticated' });
                expect(served(built.server, 'logout')).toBe(0);
                expect(built.server.session('s4')?.revoked).toBe('superseded');
                expect(built.server.sessionOf(b.state.accessToken)?.revoked).toBeNull();
                await expect(refreshSession(b.state, b.context)).resolves.toStrictEqual({ kind: 'refreshed' });
            },
        );
    });

    it.each([
        ['body', {}],
        ['cookie', { transport: 'cookie' as const }],
    ])('supersede the held session when signing in again, in %s transport', async (_label, options) => {
        const built = world(options);
        const [a, b] = await twoSignedIn(built);

        await loginWithCredentials(a.state, a.context, ALICE);
        await hydrateSession(b.state, b.context);

        expect(built.server.sessions().map(session => session.revoked)).toStrictEqual(['superseded', null]);
        expect(b.state).toStrictEqual({ ...a.state, user: null });
        await expect(refreshSession(b.state, b.context)).resolves.toStrictEqual({ kind: 'refreshed' });
    });

    it.each([
        ['is refused', { ...ALICE, password: 'wrong' }, false],
        ['is still in flight', ALICE, true],
    ])(
        'never pair the cookie of an overtaken sign-in with the held session, while the newer sign-in %s',
        async (_label, credentials, holdNewer) => {
            const built = world({ transport: 'cookie' });
            const [a, b] = await twoSignedIn(built);
            const release = a.hold('login');

            const overtaken = loginWithCredentials(a.state, a.context, BOB);

            await flush();
            const releaseNewer = holdNewer ? a.hold('login') : (): void => undefined;
            const newer = loginWithCredentials(a.state, a.context, credentials).catch((error: unknown) => error);

            release();

            await expect(overtaken).resolves.toStrictEqual({ kind: 'superseded' });
            expect(built.server.cookie).toBe('refresh-s4-5');
            expect(a.state).toStrictEqual(createInitialSessionState());
            expect(JSON.parse(built.storage.get('auth.session') ?? 'null')).toMatchObject({ session: null });

            releaseNewer();
            await newer;

            await expect(refreshSession(b.state, b.context)).resolves.toStrictEqual({ kind: 'superseded' });
            expect(b.state).toStrictEqual({ ...a.state, user: null });
            expect(served(built.server, 'refresh')).toBe(0);

            for (const { state } of [a, b]) {
                expect(state.user === null || built.server.issuerOf(state.accessToken)?.owner === state.user.id).toBe(
                    true,
                );
            }
        },
    );

    it('lose the session when a rotation that could not be persisted is replayed after the grace window', async () => {
        const built = world();
        const [a, b] = await twoSignedIn(built);
        built.storage.failures = 1;

        await expect(refreshSession(a.state, a.context)).resolves.toHaveProperty('kind', 'failed');

        built.advance(31_000);

        await expect(refreshSession(b.state, b.context)).resolves.toHaveProperty('kind', 'rejected');
        expect(built.server.session('s1')?.revoked).toBe('rotation_reuse');

        await hydrateSession(a.state, a.context);
        await hydrateSession(b.state, b.context);

        expect(a.state.accessToken).toBeNull();
        expect(b.state.accessToken).toBeNull();
    });
});
