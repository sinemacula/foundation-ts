/**
 * Unit tests for the session core transitions.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { HttpError, NetworkError } from '../http/http-error';
import { InProcessSessionLock } from './in-process-session-lock';
import type { PasswordCredentials, SessionApi, SessionDevice } from './session-api';
import type { SessionCoreContext } from './session-core';
import {
    clearSession,
    createInitialSessionState,
    hydrateSession,
    loginWithCredentials,
    logoutSession,
    refreshSession,
    rehydrateSessionUser,
    sessionIdentity,
} from './session-core';
import { SessionError } from './session-error';
import type { SessionLock } from './session-lock';
import type { LoginResult, RefreshResult } from './session-outcomes';
import type {
    PersistedSession,
    SessionClearResult,
    SessionPersistence,
    SessionSaveResult,
    SessionSnapshot,
    SessionVersion,
} from './session-persistence';
import type { SessionState } from './session-state';
import type { SessionTokens } from './session-tokens';
import type { SessionUser } from './session-user';

/** A queued gateway outcome: a value, a failure, or a pending promise. */
type Queued<T> = T | Error | Promise<T>;

/**
 * Consume the next queued outcome.
 */
function take<T>(queue: Array<Queued<T>>): Promise<T> {
    const outcome = queue.shift();

    if (outcome === undefined) {
        return Promise.reject(new Error('No queued outcome.'));
    }

    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
}

/** A promise with its settle functions exposed. */
interface Deferred<T> {
    /** The promise. */
    readonly promise: Promise<T>;

    /** Resolve the promise. */
    readonly resolve: (value: T) => void;

    /** Reject the promise. */
    readonly reject: (error: unknown) => void;
}

/**
 * Create a promise settled from outside.
 */
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });

    return { promise, resolve, reject };
}

/** The arguments of one login call. */
interface LoginCall<C> {
    /** The credentials. */
    readonly credentials: C;

    /** The device fingerprint. */
    readonly device: SessionDevice;

    /** The refresh token presented. */
    readonly refreshToken: string | null;
}

/** Credentials signing in with a one-time code. */
interface CodeCredentials {
    /** The phone number. */
    readonly phone: string;

    /** The one-time code. */
    readonly code: string;
}

/** A user with a role. */
interface AdminUser extends SessionUser {
    /** The user's role. */
    readonly role: string;
}

/**
 * An in-memory {@link SessionApi} fake that records every call and replays
 * queued outcomes in order.
 */
class FakeSessionApi<C = PasswordCredentials> implements SessionApi<SessionUser, C> {
    /** The calls made, by method name. */
    readonly calls: string[] = [];

    /** The arguments of every login call. */
    readonly loginCalls: Array<LoginCall<C>> = [];

    /** The refresh token presented by every refresh call. */
    readonly refreshCalls: Array<string | null> = [];

    /** The tokens presented by every logout call. */
    readonly logoutCalls: SessionTokens[] = [];

    /** The queued login outcomes. */
    readonly logins: Array<Queued<LoginResult>> = [];

    /** The queued refresh outcomes. */
    readonly refreshes: Array<Queued<RefreshResult>> = [];

    /** The queued user outcomes. */
    readonly users: Array<Queued<SessionUser>> = [];

    /** The queued logout outcomes. */
    readonly logouts: Array<Queued<undefined>> = [];

    /**
     * Record a login.
     */
    login(credentials: C, device: SessionDevice, refreshToken: string | null): Promise<LoginResult> {
        this.calls.push('login');
        this.loginCalls.push({ credentials, device, refreshToken });

        return take(this.logins);
    }

    /**
     * Record a refresh.
     */
    refresh(refreshToken: string | null): Promise<RefreshResult> {
        this.calls.push('refresh');
        this.refreshCalls.push(refreshToken);

        return take(this.refreshes);
    }

    /**
     * Record a logout, resolving when nothing is queued.
     */
    async logout(tokens: SessionTokens): Promise<void> {
        this.calls.push('logout');
        this.logoutCalls.push(tokens);

        if (this.logouts.length > 0) {
            await take(this.logouts);
        }
    }

    /**
     * Record a user fetch.
     */
    currentUser(): Promise<SessionUser> {
        this.calls.push('currentUser');

        return take(this.users);
    }
}

/**
 * An in-memory {@link SessionPersistence} fake recording each operation, with
 * injectable failures and gates. A gated write compares versions once its gate
 * opens, as a write waiting on a lock would.
 */
class FakePersistence implements SessionPersistence {
    /** The persisted snapshot. */
    snapshot: SessionSnapshot = { revision: 0, session: null };

    /** Every operation, in order, with the revision each write expected. */
    readonly operations: string[] = [];

    /** A failure the next load rejects with. */
    loadFailure: Error | null = null;

    /** A failure the next save rejects with. */
    saveFailure: Error | null = null;

    /** A failure the next clear rejects with. */
    clearFailure: Error | null = null;

    /** A gate the next load waits on. */
    loadGate: Promise<void> | null = null;

    /** A gate the next save waits on. */
    saveGate: Promise<void> | null = null;

    /** A gate the next clear waits on. */
    clearGate: Promise<void> | null = null;

    /**
     * Read the snapshot.
     */
    async load(): Promise<SessionSnapshot> {
        this.operations.push('load');
        await this.#pass('loadGate');
        this.#fail('loadFailure');

        return this.snapshot;
    }

    /**
     * Persist the session when the snapshot is at the expected version.
     */
    async saveIf(expected: SessionVersion, session: PersistedSession): Promise<SessionSaveResult> {
        this.operations.push(`save@${String(expected.revision)}:${session.tokens.accessToken}`);
        await this.#pass('saveGate');
        this.#fail('saveFailure');

        if (!this.#isAt(expected)) {
            return { status: 'changed', current: this.snapshot };
        }

        return { status: 'saved', revision: this.write(session.tokens, session.lineage) };
    }

    /**
     * Clear the snapshot when it is at the expected version.
     */
    async clearIf(expected: SessionVersion): Promise<SessionClearResult> {
        this.operations.push(`clear@${String(expected.revision)}`);
        await this.#pass('clearGate');
        this.#fail('clearFailure');

        if (!this.#isAt(expected)) {
            return { status: 'changed', current: this.snapshot };
        }

        return { status: 'cleared', revision: this.write(null) };
    }

    /**
     * Write a snapshot at the next revision, as another context would.
     *
     * @param tokens - the tokens to write, or null to clear
     * @param lineage - the sign-in the tokens descend from
     */
    write(tokens: SessionTokens | null, lineage = OTHER): number {
        this.snapshot = {
            revision: this.snapshot.revision + 1,
            session: tokens === null ? null : { lineage, tokens },
        };

        return this.snapshot.revision;
    }

    /**
     * Check whether the snapshot is at the given version.
     */
    #isAt(expected: SessionVersion): boolean {
        return (
            this.snapshot.revision === expected.revision &&
            (this.snapshot.session?.lineage ?? null) === expected.lineage
        );
    }

    /**
     * Wait on the gate stored under the given field, once.
     */
    async #pass(field: 'loadGate' | 'saveGate' | 'clearGate'): Promise<void> {
        const gate = this[field];

        this[field] = null;

        if (gate !== null) {
            await gate;
        }
    }

    /**
     * Throw, once, the failure stored under the given field.
     */
    #fail(field: 'loadFailure' | 'saveFailure' | 'clearFailure'): void {
        const failure = this[field];

        this[field] = null;

        if (failure !== null) {
            throw failure;
        }
    }
}

/**
 * A lock counting the tasks it runs.
 */
class CountingLock implements SessionLock {
    /** How many tasks have been run. */
    runs = 0;

    /** The lock the tasks run under. */
    readonly #inner = new InProcessSessionLock();

    /**
     * Count the task, then run it.
     */
    run<T>(task: () => Promise<T>): Promise<T> {
        this.runs += 1;

        return this.#inner.run(task);
    }
}

const HELD = 'held';
const OTHER = 'other';
const DEVICE: SessionDevice = { uuid: 'device-uuid', os: 'macOS' };
const CREDENTIALS: PasswordCredentials = { email: 'alice@example.com', password: 'secret' };
const ALICE: SessionUser = { id: 'u1', email: 'alice@example.com', name: 'Alice', permissions: [] };
const BOB: SessionUser = { id: 'u2', email: 'bob@example.com', name: 'Bob', permissions: [] };
const REJECTED = { kind: 'rejected', error: null } as const;
const PENDING = { credential: 'pending', requires: ['mfa'] };

/**
 * Build a token set.
 *
 * @param suffix - distinguishes the tokens of one pair from another
 */
function tokens(suffix: string, overrides: Partial<SessionTokens> = {}): SessionTokens {
    return { accessToken: `access-${suffix}`, refreshToken: `refresh-${suffix}`, expiresAtEpochMs: 1000, ...overrides };
}

/**
 * Build a persisted session.
 */
function persisted(suffix: string, lineage = HELD): PersistedSession {
    return { lineage, tokens: tokens(suffix) };
}

/** A test fixture: the state, the fakes, and the context over them. */
interface Fixture<C = PasswordCredentials> {
    /** The session state. */
    readonly state: SessionState;

    /** The gateway fake. */
    readonly api: FakeSessionApi<C>;

    /** The persistence fake. */
    readonly persistence: FakePersistence;

    /** The context over the fakes. */
    readonly context: SessionCoreContext<SessionUser, C>;
}

/**
 * Build a context whose sign-ins take the lineages `lineage-1`, `lineage-2` and
 * so on.
 */
function contextOver<C>(
    api: SessionApi<SessionUser, C>,
    persistence: SessionPersistence,
): SessionCoreContext<SessionUser, C> {
    let sequence = 0;

    return {
        api,
        persistence,
        device: () => DEVICE,
        createLineage: () => {
            sequence += 1;

            return `lineage-${String(sequence)}`;
        },
    };
}

/**
 * Build a signed-out fixture over an empty store.
 */
function fixture(): Fixture {
    const state = createInitialSessionState();
    const api = new FakeSessionApi();
    const persistence = new FakePersistence();

    return { state, api, persistence, context: contextOver(api, persistence) };
}

/**
 * Build a fixture hydrated from a store holding the given tokens, under the
 * held lineage at the given revision, with Alice loaded and the operation log
 * emptied.
 */
async function signedIn(signedIn: SessionTokens, revision = 1): Promise<Fixture> {
    const built = fixture();

    built.persistence.snapshot = { revision, session: { lineage: HELD, tokens: signedIn } };
    await hydrateSession(built.state, built.context);
    built.state.user = ALICE;
    built.persistence.operations.length = 0;

    return built;
}

/**
 * A device fingerprint that cannot be read.
 */
function unreadableDevice(): SessionDevice {
    throw new Error('no device');
}

/**
 * Read the token fields of the state.
 */
function tokensOf(state: SessionState): Record<string, unknown> {
    return {
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        expiresAtEpochMs: state.expiresAtEpochMs,
    };
}

/**
 * Let every queued microtask run.
 */
async function flush(): Promise<void> {
    await new Promise<void>(resolve => {
        setTimeout(resolve, 0);
    });
}

describe('createInitialSessionState', () => {
    it('builds a signed-out state', () => {
        expect(createInitialSessionState()).toStrictEqual({
            accessToken: null,
            refreshToken: null,
            expiresAtEpochMs: null,
            user: null,
        });
    });
});

describe('hydrateSession', () => {
    it('reads the persisted session into state', async () => {
        const { state, persistence, context } = fixture();
        persistence.snapshot = { revision: 1, session: persisted('a') };

        await hydrateSession(state, context);

        expect(state).toStrictEqual({ ...tokens('a'), user: null });
        expect(persistence.operations).toStrictEqual(['load']);
    });

    it('leaves a signed-out state alone when nothing is persisted', async () => {
        const { state, context } = fixture();

        await hydrateSession(state, context);

        expect(state).toStrictEqual(createInitialSessionState());
    });

    it('keeps the state, user included, when the persisted version is its own', async () => {
        const { state, context } = await signedIn(tokens('a'));

        await hydrateSession(state, context);

        expect(state).toStrictEqual({ ...tokens('a'), user: ALICE });
    });

    it('signs the state out when another context cleared the session', async () => {
        const { state, persistence, context } = await signedIn(tokens('a'));
        persistence.write(null);

        await hydrateSession(state, context);

        expect(state).toStrictEqual(createInitialSessionState());
    });

    it('adopts a session another context signed in, dropping the user and identity', async () => {
        const { state, persistence, context } = await signedIn(tokens('a'));
        const identity = sessionIdentity(state);
        persistence.write(tokens('b'));

        await hydrateSession(state, context);

        expect(state).toStrictEqual({ ...tokens('b'), user: null });
        expect(sessionIdentity(state)).not.toBe(identity);
    });

    it('takes the tokens of a rotation another context persisted, keeping the user and identity', async () => {
        const { state, persistence, context } = await signedIn(tokens('a'));
        const identity = sessionIdentity(state);
        persistence.write(tokens('b'), HELD);

        await hydrateSession(state, context);

        expect(state).toStrictEqual({ ...tokens('b'), user: ALICE });
        expect(sessionIdentity(state)).toBe(identity);
    });

    it('replaces the session when a store reset reuses its revision for another sign-in', async () => {
        const { state, persistence, context } = await signedIn(tokens('a'));
        persistence.snapshot = { revision: 1, session: persisted('b', OTHER) };

        await hydrateSession(state, context);

        expect(state).toStrictEqual({ ...tokens('b'), user: null });
    });

    it('signs the state out, never adopting the older pair, when the store was reset beneath it', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'), 3);
        persistence.snapshot = { revision: 1, session: persisted('old', OTHER) };
        api.logins.push({ kind: 'authenticated', tokens: tokens('b') });
        api.users.push(BOB);

        await hydrateSession(state, context);

        expect(state).toStrictEqual(createInitialSessionState());

        await loginWithCredentials(state, context, CREDENTIALS);

        expect(persistence.operations).toStrictEqual(['load', 'save@1:access-b']);
    });

    it('records another context signing out while signed out, without superseding a sign-in', async () => {
        const { state, api, persistence, context } = fixture();
        const response = deferred<LoginResult>();
        api.logins.push(response.promise);
        api.users.push(ALICE);
        persistence.write(null);

        const login = loginWithCredentials(state, context, CREDENTIALS);

        await hydrateSession(state, context);
        response.resolve({ kind: 'authenticated', tokens: tokens('a') });

        await expect(login).resolves.toStrictEqual({ kind: 'authenticated' });
        expect(persistence.operations).toStrictEqual(['load', 'save@1:access-a']);
    });

    it.each([
        ['another sign-in', null],
        ['a sign-out', 'cleared'],
    ] as const)('supersedes an in-flight refresh when another context persisted %s', async (_label, kind) => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const response = deferred<RefreshResult>();
        api.refreshes.push(response.promise);

        const refresh = refreshSession(state, context);

        await flush();
        persistence.write(kind === null ? tokens('b') : null);
        await hydrateSession(state, context);
        response.resolve({ kind: 'refreshed', tokens: tokens('c') });

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(api.refreshCalls).toStrictEqual(['refresh-a']);
        expect(state.accessToken).toBe(kind === null ? 'access-b' : null);
        expect(persistence.snapshot.revision).toBe(2);
    });

    it('supersedes an in-flight sign-in when another context signed in', async () => {
        const { state, api, persistence, context } = fixture();
        const response = deferred<LoginResult>();
        api.logins.push(response.promise);

        const login = loginWithCredentials(state, context, CREDENTIALS);

        persistence.write(tokens('elsewhere'));
        await hydrateSession(state, context);
        response.resolve({ kind: 'authenticated', tokens: tokens('a') });

        await expect(login).resolves.toStrictEqual({ kind: 'superseded' });
        expect(tokensOf(state)).toStrictEqual(tokens('elsewhere'));
        expect(api.calls).toStrictEqual(['login', 'logout']);
        expect(api.logoutCalls).toStrictEqual([tokens('a')]);
    });

    it.each([
        ['a refused sign-in', 'refused'],
        ['a pending sign-in', 'pending'],
        ['a device that cannot be read', 'device'],
        ['an empty lineage', 'lineage'],
    ] as const)('lets a hydration that %s overtook adopt the stored session', async (_label, failure) => {
        const { state, api, persistence, context } = fixture();
        const gate = deferred<undefined>();
        persistence.write(tokens('other'));
        persistence.loadGate = gate.promise;
        api.logins.push(
            failure === 'pending' ? { kind: 'interactionRequired', pending: PENDING } : new HttpError(422, 'Invalid'),
        );

        const hydrate = hydrateSession(state, context);

        await flush();
        await loginWithCredentials(
            state,
            {
                ...context,
                device: failure === 'device' ? unreadableDevice : context.device,
                createLineage: failure === 'lineage' ? (): string => '' : context.createLineage,
            },
            CREDENTIALS,
        ).catch(() => undefined);
        gate.resolve(undefined);
        await hydrate;

        expect(tokensOf(state)).toStrictEqual(tokens('other'));

        await clearSession(state, context);

        expect(persistence.operations).toStrictEqual(['load', 'clear@1']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: null });
    });

    it.each([
        ['before', true],
        ['after', false],
    ])(
        'leaves a successful sign-in in place when an older hydration settles %s its response',
        async (_label, first) => {
            const { state, api, persistence, context } = fixture();
            const gate = deferred<undefined>();
            const response = deferred<LoginResult>();
            persistence.write(tokens('other'));
            persistence.loadGate = gate.promise;
            api.logins.push(response.promise);
            api.users.push(ALICE);

            const hydrate = hydrateSession(state, context);

            await flush();
            const login = loginWithCredentials(state, context, CREDENTIALS);

            await flush();

            if (first) {
                gate.resolve(undefined);
                await hydrate;
                response.resolve({ kind: 'authenticated', tokens: tokens('a') });
            } else {
                response.resolve({ kind: 'authenticated', tokens: tokens('a') });
                await flush();
                gate.resolve(undefined);
            }

            await expect(login).resolves.toStrictEqual({ kind: 'authenticated' });
            expect(state).toStrictEqual({ ...tokens('a'), user: ALICE });
            expect(persistence.snapshot).toStrictEqual({ revision: 2, session: persisted('a', 'lineage-1') });
        },
    );

    it('discards the snapshot when a transition overtook the read', async () => {
        const { state, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        persistence.loadGate = gate.promise;

        const hydrate = hydrateSession(state, context);

        await flush();
        const clear = clearSession(state, context);

        persistence.write(tokens('stale'));
        gate.resolve(undefined);
        await Promise.all([hydrate, clear]);

        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['load', 'clear@1', 'clear@2']);
    });

    it('skips the read when a transition overtook it before it ran', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveGate = gate.promise;

        const refresh = refreshSession(state, context);

        await flush();
        const hydrate = hydrateSession(state, context);
        const clear = clearSession(state, context);

        gate.resolve(undefined);
        await Promise.all([refresh, hydrate, clear]);

        expect(persistence.operations).toStrictEqual(['load', 'save@1:access-b', 'clear@2']);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, session: null });
    });

    it('propagates a persistence failure', async () => {
        const { state, persistence, context } = fixture();
        persistence.loadFailure = new Error('unavailable');

        await expect(hydrateSession(state, context)).rejects.toThrow('unavailable');
    });

    it('persists a rotated pair that could not be persisted, instead of reading the spent one', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);

        await hydrateSession(state, context);

        expect(persistence.operations).toStrictEqual(['load', 'save@1:access-b', 'save@1:access-b']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: persisted('b') });
        expect(state).toStrictEqual({ ...tokens('b'), user: ALICE });

        await hydrateSession(state, context);

        expect(persistence.operations.at(-1)).toBe('load');
    });

    it('propagates a failure to persist the rotated pair, keeping it', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);
        persistence.saveFailure = new Error('still full');

        await expect(hydrateSession(state, context)).rejects.toThrow('still full');
        expect(tokensOf(state)).toStrictEqual(tokens('b'));
        expect(persistence.snapshot).toStrictEqual({ revision: 1, session: persisted('a') });
    });

    it.each([
        ['another sign-in', OTHER, null],
        ['a rotation of the held session', HELD, ALICE],
    ])('adopts %s over a rotated pair that could not be persisted', async (_label, lineage, user) => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);
        persistence.write(tokens('c'), lineage);

        await hydrateSession(state, context);

        expect(state).toStrictEqual({ ...tokens('c'), user });

        await hydrateSession(state, context);

        expect(persistence.operations.at(-1)).toBe('load');
    });
});

describe('loginWithCredentials', () => {
    it('signs in, persists the session under a new lineage, then loads the user', async () => {
        const { state, api, persistence, context } = fixture();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(ALICE);

        await expect(loginWithCredentials(state, context, CREDENTIALS)).resolves.toStrictEqual({
            kind: 'authenticated',
        });

        expect(api.loginCalls).toStrictEqual([{ credentials: CREDENTIALS, device: DEVICE, refreshToken: null }]);
        expect(api.calls).toStrictEqual(['login', 'currentUser']);
        expect(persistence.operations).toStrictEqual(['save@0:access-a']);
        expect(persistence.snapshot).toStrictEqual({ revision: 1, session: persisted('a', 'lineage-1') });
        expect(state).toStrictEqual({ ...tokens('a'), user: ALICE });
    });

    it('presents the held refresh token and holds the new tokens while the user loads', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('old'));
        const user = deferred<SessionUser>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(user.promise);

        const login = loginWithCredentials(state, context, CREDENTIALS);

        await flush();

        expect(api.loginCalls[0]?.refreshToken).toBe('refresh-old');
        expect(state).toStrictEqual({ ...tokens('a'), user: null });
        expect(persistence.snapshot.session).toStrictEqual(persisted('a', 'lineage-1'));

        user.resolve(BOB);
        await login;

        expect(state.user).toStrictEqual(BOB);
        expect(persistence.operations).toStrictEqual(['save@1:access-a']);
    });

    it('forwards typed credentials without casts', async () => {
        const api = new FakeSessionApi<CodeCredentials>();
        const persistence = new FakePersistence();
        const state = createInitialSessionState();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(ALICE);

        await loginWithCredentials(state, contextOver(api, persistence), { phone: '+44', code: '123' });

        expect(api.loginCalls[0]?.credentials).toStrictEqual({ phone: '+44', code: '123' });
    });

    it('hands back a pending sign-in without persisting anything', async () => {
        const { state, api, persistence, context } = fixture();
        api.logins.push({ kind: 'interactionRequired', pending: PENDING });

        await expect(loginWithCredentials(state, context, CREDENTIALS)).resolves.toStrictEqual({
            kind: 'interactionRequired',
            pending: PENDING,
        });

        expect(api.calls).toStrictEqual(['login']);
        expect(persistence.operations).toStrictEqual([]);
        expect(state).toStrictEqual(createInitialSessionState());
    });

    it('propagates a failed sign-in, leaving the state alone', async () => {
        const { state, api, persistence, context } = fixture();
        api.logins.push(new HttpError(422, 'Invalid'));

        await expect(loginWithCredentials(state, context, CREDENTIALS)).rejects.toThrow('Invalid');

        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual([]);
    });

    it.each([
        ['an empty lineage', ''],
        ['a lineage that is not a string', 42],
    ])('rejects %s before sending anything', async (_label, lineage) => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));

        const error: unknown = await loginWithCredentials(
            state,
            { ...context, createLineage: () => lineage as string },
            CREDENTIALS,
        ).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(SessionError);
        expect(error).toHaveProperty('message', 'The session lineage must be a non-empty string.');
        expect(api.calls).toStrictEqual([]);
        expect(persistence.operations).toStrictEqual([]);
        expect(state).toStrictEqual({ ...tokens('a'), user: ALICE });
    });

    it('propagates a device that cannot be read before sending anything', async () => {
        const { state, api, context } = fixture();

        await expect(
            loginWithCredentials(state, { ...context, device: unreadableDevice }, CREDENTIALS),
        ).rejects.toThrow('no device');
        expect(api.calls).toStrictEqual([]);
    });

    it('writes over a session another context persisted meanwhile', async () => {
        const { state, api, persistence, context } = fixture();
        const gate = deferred<undefined>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(ALICE);
        persistence.saveGate = gate.promise;

        const login = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        persistence.write(tokens('elsewhere'));
        gate.resolve(undefined);

        await expect(login).resolves.toStrictEqual({ kind: 'authenticated' });
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'save@1:access-a']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: persisted('a', 'lineage-1') });

        await hydrateSession(state, context);

        expect(state).toStrictEqual({ ...tokens('a'), user: ALICE });
    });

    it('rolls the session back when the user cannot be loaded', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('old'));
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(new NetworkError('offline'));

        await expect(loginWithCredentials(state, context, CREDENTIALS)).rejects.toThrow('offline');

        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['save@1:access-a', 'clear@2']);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, session: null });
    });

    it('rolls the session back and signs it out when it cannot be persisted', async () => {
        const { state, api, persistence, context } = fixture();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(ALICE);
        persistence.saveFailure = new Error('quota');

        await expect(loginWithCredentials(state, context, CREDENTIALS)).rejects.toThrow('quota');

        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'clear@0']);
        expect(api.logoutCalls).toStrictEqual([tokens('a')]);
    });

    it.each([
        ['rejects', (): Promise<void> => Promise.reject(new Error('offline'))],
        [
            'throws',
            (): Promise<void> => {
                throw new Error('offline');
            },
        ],
    ])('rethrows the persistence failure when signing the unpersisted session out %s', async (_label, logout) => {
        const { state, api, persistence, context } = fixture();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.logout = logout;
        persistence.saveFailure = new Error('quota');

        await expect(loginWithCredentials(state, context, CREDENTIALS)).rejects.toThrow('quota');

        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'clear@0']);
    });

    it('rethrows the original failure when the rollback cannot clear persistence', async () => {
        const { state, api, persistence, context } = fixture();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(new Error('user failed'));
        persistence.clearFailure = new Error('clear failed');

        await expect(loginWithCredentials(state, context, CREDENTIALS)).rejects.toThrow('user failed');

        expect(state).toStrictEqual(createInitialSessionState());
    });

    it('rolls back a session that cannot be persisted before a newer sign-in sends, leaving that sign-in to land', async () => {
        const { state, api, persistence, context } = fixture();
        const gate = deferred<undefined>();
        const later = deferred<LoginResult>();
        const signedOut = deferred<undefined>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') }, later.promise);
        api.logouts.push(signedOut.promise);
        api.users.push(BOB);
        persistence.saveGate = gate.promise;
        persistence.saveFailure = new Error('quota');

        const first = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        const second = loginWithCredentials(state, context, CREDENTIALS);

        gate.resolve(undefined);
        await flush();

        expect(api.calls).toStrictEqual(['login', 'logout']);

        signedOut.resolve(undefined);

        await expect(first).rejects.toThrow('quota');
        expect(api.logoutCalls).toStrictEqual([tokens('a')]);
        expect(state).toStrictEqual(createInitialSessionState());
        expect(api.loginCalls.map(call => call.refreshToken)).toStrictEqual([null, null]);

        later.resolve({ kind: 'authenticated', tokens: tokens('b') });

        await expect(second).resolves.toStrictEqual({ kind: 'authenticated' });
        expect(state).toStrictEqual({ ...tokens('b'), user: BOB });
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'clear@0', 'save@1:access-b']);
    });

    it('rolls back a session a newer sign-in overtook before it could be persisted', async () => {
        const { state, api, persistence, context } = fixture();
        const gate = deferred<undefined>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') }, { kind: 'authenticated', tokens: tokens('b') });
        api.users.push(BOB);
        persistence.saveGate = gate.promise;

        const first = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        persistence.write(null);
        const second = loginWithCredentials(state, context, CREDENTIALS);

        gate.resolve(undefined);

        await expect(first).resolves.toStrictEqual({ kind: 'superseded' });
        await expect(second).resolves.toStrictEqual({ kind: 'authenticated' });
        expect(api.loginCalls.map(call => call.refreshToken)).toStrictEqual([null, null]);
        expect(api.logoutCalls).toStrictEqual([tokens('a')]);
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'clear@0', 'clear@1', 'save@2:access-b']);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, session: persisted('b', 'lineage-2') });
    });

    it('is superseded by a sign-out during the sign-in request', async () => {
        const { state, api, persistence, context } = fixture();
        const response = deferred<LoginResult>();
        api.logins.push(response.promise);

        const login = loginWithCredentials(state, context, CREDENTIALS);

        await logoutSession(state, context);
        response.resolve({ kind: 'authenticated', tokens: tokens('a') });

        await expect(login).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['clear@0']);
    });

    it('sends nothing when a sign-out overtook it before it held the exchange lock', async () => {
        const { state, api, context } = fixture();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });

        const login = loginWithCredentials(state, context, CREDENTIALS);

        await clearSession(state, context);

        await expect(login).resolves.toStrictEqual({ kind: 'superseded' });
        expect(api.calls).toStrictEqual([]);
    });

    it('is superseded by a sign-out while the user loads, which clears the persisted session', async () => {
        const { state, api, persistence, context } = fixture();
        const user = deferred<SessionUser>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(user.promise);

        const login = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        await logoutSession(state, context);
        user.resolve(ALICE);

        await expect(login).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'clear@1', 'load']);
        expect(api.logoutCalls).toStrictEqual([tokens('a')]);
    });

    it('is superseded by a sign-out while the session persists, setting no user', async () => {
        const { state, api, persistence, context } = fixture();
        const gate = deferred<undefined>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(ALICE);
        persistence.saveGate = gate.promise;

        const login = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        const logout = logoutSession(state, context);

        gate.resolve(undefined);
        await logout;

        await expect(login).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'clear@1', 'load']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: null });
        expect(api.calls).toStrictEqual(['login', 'logout']);
    });

    it('skips the write when a sign-out overtook it before it ran', async () => {
        const { state, api, persistence, context } = fixture();
        const gate = deferred<undefined>();
        persistence.loadGate = gate.promise;
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(ALICE);

        const hydrate = hydrateSession(state, context);

        await flush();
        const login = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        const logout = logoutSession(state, context);

        gate.resolve(undefined);
        await Promise.all([hydrate, logout]);

        await expect(login).resolves.toStrictEqual({ kind: 'superseded' });
        expect(persistence.operations).toStrictEqual(['load', 'clear@0', 'load']);
    });

    it('leaves a newer sign-in alone when an overtaken sign-in fails', async () => {
        const { state, api, persistence, context } = fixture();
        const firstUser = deferred<SessionUser>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(firstUser.promise);

        const first = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        api.logins.push({ kind: 'authenticated', tokens: tokens('b') });
        api.users.push(BOB);
        await loginWithCredentials(state, context, CREDENTIALS);
        firstUser.reject(new Error('first failed'));

        await expect(first).rejects.toThrow('first failed');
        expect(api.loginCalls[1]?.refreshToken).toBe('refresh-a');
        expect(state).toStrictEqual({ ...tokens('b'), user: BOB });
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: persisted('b', 'lineage-2') });
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'save@1:access-b']);
    });

    it('leaves a newer sign-in that has not landed alone when an overtaken sign-in fails', async () => {
        const { state, api, persistence, context } = fixture();
        const firstUser = deferred<SessionUser>();
        const later = deferred<LoginResult>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') }, later.promise);
        api.users.push(firstUser.promise, BOB);

        const first = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        const second = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        firstUser.reject(new Error('first failed'));

        await expect(first).rejects.toThrow('first failed');
        expect(tokensOf(state)).toStrictEqual(tokens('a'));

        later.resolve({ kind: 'authenticated', tokens: tokens('b') });

        await expect(second).resolves.toStrictEqual({ kind: 'authenticated' });
        expect(state).toStrictEqual({ ...tokens('b'), user: BOB });
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'save@1:access-b']);
    });

    it('lets the later of two overlapping sign-ins win when the earlier answers first', async () => {
        const { state, api, persistence, context } = fixture();
        const earlier = deferred<LoginResult>();
        const later = deferred<LoginResult>();
        api.logins.push(earlier.promise, later.promise);
        api.users.push(BOB);

        const first = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        const second = loginWithCredentials(state, context, CREDENTIALS);

        earlier.resolve({ kind: 'authenticated', tokens: tokens('a') });

        await expect(first).resolves.toStrictEqual({ kind: 'superseded' });

        later.resolve({ kind: 'authenticated', tokens: tokens('b') });

        await expect(second).resolves.toStrictEqual({ kind: 'authenticated' });
        expect(state).toStrictEqual({ ...tokens('b'), user: BOB });
        expect(persistence.operations).toStrictEqual(['save@0:access-b']);
    });

    it('keeps the pair a refresh rotated while the user loads', async () => {
        const { state, api, persistence, context } = fixture();
        const user = deferred<SessionUser>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(user.promise);
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });

        const login = loginWithCredentials(state, context, CREDENTIALS);

        await flush();

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'refreshed' });

        user.resolve(ALICE);

        await expect(login).resolves.toStrictEqual({ kind: 'authenticated' });
        expect(api.refreshCalls).toStrictEqual(['refresh-a']);
        expect(state).toStrictEqual({ ...tokens('b'), user: ALICE });
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'load', 'save@1:access-b']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: persisted('b', 'lineage-1') });
    });

    it('stops writing over another context once a sign-out overtakes it', async () => {
        const { state, api, persistence, context } = fixture();
        const gate = deferred<undefined>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        persistence.saveGate = gate.promise;

        const login = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        persistence.write(tokens('elsewhere'));
        const logout = logoutSession(state, context);

        gate.resolve(undefined);
        await logout;

        await expect(login).resolves.toStrictEqual({ kind: 'superseded' });
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'clear@0', 'clear@1', 'load']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: null });
    });

    it('is superseded when its session is refused while the user loads', async () => {
        const { state, api, persistence, context } = fixture();
        const user = deferred<SessionUser>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(user.promise);
        api.refreshes.push(REJECTED);

        const login = loginWithCredentials(state, context, CREDENTIALS);

        await flush();

        await expect(refreshSession(state, context)).resolves.toStrictEqual(REJECTED);

        user.resolve(ALICE);

        await expect(login).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: null });
    });

    it('is superseded by a later sign-in that starts while the user loads', async () => {
        const { state, api, context } = fixture();
        const user = deferred<SessionUser>();
        const later = deferred<LoginResult>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') }, later.promise);
        api.users.push(user.promise, BOB);

        const first = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        const second = loginWithCredentials(state, context, CREDENTIALS);

        user.resolve(ALICE);

        await expect(first).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state.user).toBeNull();

        later.resolve({ kind: 'authenticated', tokens: tokens('b') });

        await expect(second).resolves.toStrictEqual({ kind: 'authenticated' });
        expect(state).toStrictEqual({ ...tokens('b'), user: BOB });
    });

    it('is superseded when another context replaced its session while the user loads', async () => {
        const { state, api, persistence, context } = fixture();
        const user = deferred<SessionUser>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(user.promise);

        const login = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        persistence.write(tokens('elsewhere'));
        await hydrateSession(state, context);
        user.resolve(ALICE);

        await expect(login).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual({ ...tokens('elsewhere'), user: null });
    });

    it('keeps the user it loads when another context rotated its session meanwhile', async () => {
        const { state, api, persistence, context } = fixture();
        const user = deferred<SessionUser>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(user.promise);

        const login = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        persistence.write(tokens('b'), 'lineage-1');
        await hydrateSession(state, context);
        user.resolve(ALICE);

        await expect(login).resolves.toStrictEqual({ kind: 'authenticated' });
        expect(state).toStrictEqual({ ...tokens('b'), user: ALICE });
    });
});

describe('refreshSession', () => {
    it('reads the store, presents the refresh token, persists the new pair, then applies it', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveGate = gate.promise;

        const refresh = refreshSession(state, context);

        await flush();

        expect(tokensOf(state)).toStrictEqual(tokens('a'));

        gate.resolve(undefined);

        await expect(refresh).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(api.refreshCalls).toStrictEqual(['refresh-a']);
        expect(persistence.operations).toStrictEqual(['load', 'save@1:access-b']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: persisted('b') });
        expect(state).toStrictEqual({ ...tokens('b'), user: ALICE });
    });

    it('refreshes without a held refresh token, as with a cookie transport', async () => {
        const { state, api, context } = await signedIn(tokens('a', { refreshToken: null }));
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b', { refreshToken: null }) });

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(api.refreshCalls).toStrictEqual([null]);
        expect(state.accessToken).toBe('access-b');
    });

    it('makes no request while the state holds no session', async () => {
        const { state, api, persistence, context } = fixture();

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'superseded' });
        expect(api.calls).toStrictEqual([]);
        expect(persistence.operations).toStrictEqual([]);
    });

    it('takes a rotation another context persisted instead of presenting the spent token', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const identity = sessionIdentity(state);
        persistence.write(tokens('b'), HELD);

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(api.calls).toStrictEqual([]);
        expect(state).toStrictEqual({ ...tokens('b'), user: ALICE });
        expect(sessionIdentity(state)).toBe(identity);
    });

    it.each([
        ['another sign-in', tokens('b'), { ...tokens('b'), user: null }],
        ['a sign-out', null, { ...createInitialSessionState() }],
    ])('is superseded, without a request, by %s another context persisted', async (_label, written, expected) => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        persistence.write(written);

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'superseded' });
        expect(api.calls).toStrictEqual([]);
        expect(state).toStrictEqual(expected);
    });

    it('reports a failure to read the store without a request, keeping the tokens', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const failure = new Error('unreadable');
        persistence.loadFailure = failure;

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'failed', error: failure });
        expect(api.calls).toStrictEqual([]);
        expect(state).toStrictEqual({ ...tokens('a'), user: ALICE });
    });

    it('is superseded without a request when a sign-out overtakes its read', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.loadGate = gate.promise;

        const refresh = refreshSession(state, context);

        await flush();
        const clear = clearSession(state, context);

        gate.resolve(undefined);
        await clear;

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(api.calls).toStrictEqual([]);
        expect(persistence.operations).toStrictEqual(['load', 'clear@1']);
    });

    it('adopts nothing it read once a sign-out overtakes its read', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        persistence.loadGate = gate.promise;

        const refresh = refreshSession(state, context);

        await flush();
        const clear = clearSession(state, context);

        persistence.write(tokens('b'));
        gate.resolve(undefined);
        await clear;

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(api.calls).toStrictEqual([]);
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.snapshot).toStrictEqual({ revision: 3, session: null });
    });

    it.each([
        ['persist a rotation', { kind: 'refreshed', tokens: tokens('b') }],
        ['clear a refused session', REJECTED],
    ] as const)('leaves the store alone when a clear overtakes it before it can %s', async (_label, result) => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const response = deferred<RefreshResult>();
        const gate = deferred<undefined>();
        api.refreshes.push(response.promise);

        const refresh = refreshSession(state, context);

        await flush();
        persistence.loadGate = gate.promise;
        const hydrate = hydrateSession(state, context);

        response.resolve(result);
        await flush();
        const clear = clearSession(state, context);

        gate.resolve(undefined);
        await Promise.all([hydrate, clear]);

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(persistence.operations).toStrictEqual(['load', 'load', 'clear@1']);
    });

    it('reports a rejected exchange lock as a failure, without a request', async () => {
        const { state, api, context } = await signedIn(tokens('a'));
        const failure = new Error('lock unavailable');

        await expect(
            refreshSession(state, { ...context, exchangeLock: { run: () => Promise.reject(failure) } }),
        ).resolves.toStrictEqual({ kind: 'failed', error: failure });
        expect(api.calls).toStrictEqual([]);
    });

    it('serialises refreshes, the later one taking the earlier rotation without a request', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });

        const results = await Promise.all([refreshSession(state, context), refreshSession(state, context)]);

        expect(results).toStrictEqual([{ kind: 'refreshed' }, { kind: 'refreshed' }]);
        expect(api.refreshCalls).toStrictEqual(['refresh-a']);
        expect(persistence.operations).toStrictEqual(['load', 'save@1:access-b', 'load']);
    });

    it('keeps the new pair in memory and reports a failure when it cannot be persisted', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const failure = new Error('quota');
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveFailure = failure;

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'failed', error: failure });
        expect(state).toStrictEqual({ ...tokens('b'), user: ALICE });
        expect(persistence.snapshot).toStrictEqual({ revision: 1, session: persisted('a') });
    });

    it('persists the unsaved pair, then the next rotation over it', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('c') });
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(api.refreshCalls).toStrictEqual(['refresh-a', 'refresh-b']);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, session: persisted('c') });

        await hydrateSession(state, context);

        expect(persistence.operations.at(-1)).toBe('load');
    });

    it('persists a pair a failed save left unsaved before asking the server again', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const error = new NetworkError('offline');
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        api.refreshes.push({ kind: 'retryable', error });
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'retryable', error });
        expect(api.refreshCalls).toStrictEqual(['refresh-a', 'refresh-b']);
        expect(persistence.operations).toStrictEqual(['load', 'save@1:access-b', 'save@1:access-b']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: persisted('b') });

        await hydrateSession(state, context);

        expect(persistence.operations.at(-1)).toBe('load');
    });

    it('reports a pair that still cannot be persisted without asking the server', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const failure = new Error('still full');
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);
        persistence.saveFailure = failure;

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'failed', error: failure });
        expect(api.refreshCalls).toStrictEqual(['refresh-a']);
        expect(state).toStrictEqual({ ...tokens('b'), user: ALICE });
    });

    it('is superseded, without a request, by another sign-in found instead of persisting an unsaved pair', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);
        persistence.write(tokens('c'));

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'superseded' });
        expect(api.refreshCalls).toStrictEqual(['refresh-a']);
        expect(state).toStrictEqual({ ...tokens('c'), user: null });
    });

    it('takes a rotation found instead of persisting an unsaved pair, then rotates it', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') }, { kind: 'refreshed', tokens: tokens('d') });
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);
        persistence.write(tokens('c'), HELD);

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(api.refreshCalls).toStrictEqual(['refresh-a', 'refresh-c']);
        expect(state).toStrictEqual({ ...tokens('d'), user: ALICE });
        expect(persistence.snapshot).toStrictEqual({ revision: 3, session: persisted('d') });
    });

    it('asks the server once a queued hydration has persisted the unsaved pair', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('c') });
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);
        persistence.saveGate = gate.promise;

        const hydrate = hydrateSession(state, context);
        const refresh = refreshSession(state, context);

        gate.resolve(undefined);
        await hydrate;

        await expect(refresh).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(persistence.operations).toStrictEqual(['load', 'save@1:access-b', 'save@1:access-b', 'save@2:access-c']);
    });

    it('is superseded without a request when a clear overtakes the persisting of an unsaved pair', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);
        persistence.saveGate = gate.promise;

        const refresh = refreshSession(state, context);

        await flush();
        const clear = clearSession(state, context);

        gate.resolve(undefined);
        await clear;

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(api.refreshCalls).toStrictEqual(['refresh-a']);
        expect(persistence.operations).toStrictEqual(['load', 'save@1:access-b', 'save@1:access-b', 'clear@2']);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, session: null });
    });

    it('clears a refused session at the revision its retried save produced', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        api.refreshes.push(REJECTED);
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);

        await expect(refreshSession(state, context)).resolves.toStrictEqual(REJECTED);
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['load', 'save@1:access-b', 'save@1:access-b', 'clear@2']);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, session: null });
    });

    it.each([
        ['another sign-in', OTHER, { kind: 'superseded' }, null],
        ['a rotation of the held session', HELD, { kind: 'refreshed' }, ALICE],
    ])('adopts %s persisted while the rotation waited', async (_label, lineage, outcome, user) => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveGate = gate.promise;

        const refresh = refreshSession(state, context);

        await flush();
        persistence.write(tokens('elsewhere'), lineage);
        gate.resolve(undefined);

        await expect(refresh).resolves.toStrictEqual(outcome);
        expect(state).toStrictEqual({ ...tokens('elsewhere'), user });
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: persisted('elsewhere', lineage) });
    });

    it('is superseded when another context signed out while the rotation waited', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveGate = gate.promise;

        const refresh = refreshSession(state, context);

        await flush();
        persistence.write(null);
        gate.resolve(undefined);

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual(createInitialSessionState());
    });

    it.each(['retryable', 'failed'] as const)('keeps the tokens on a %s failure', async kind => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const error = new HttpError(500, 'Server');
        api.refreshes.push({ kind, error });

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind, error });
        expect(state).toStrictEqual({ ...tokens('a'), user: ALICE });
        expect(persistence.operations).toStrictEqual(['load']);
    });

    it('classifies a failure the gateway throws, keeping the tokens when transient', async () => {
        const { state, api, context } = await signedIn(tokens('a'));
        const error = new NetworkError('offline');
        api.refreshes.push(error);

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'retryable', error });
        expect(tokensOf(state)).toStrictEqual(tokens('a'));
    });

    it('classifies a thrown 401 as a rejection, clearing the session', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const error = new HttpError(401, 'Unauthorized');
        api.refreshes.push(error);

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'rejected', error });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: null });
    });

    it.each([
        ['a rejection', REJECTED],
        ['a return to pending', { kind: 'interactionRequired', pending: PENDING }],
    ] as const)('clears the persisted session on %s', async (_label, result) => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        api.refreshes.push(result);

        await expect(refreshSession(state, context)).resolves.toStrictEqual(result);
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: null });

        api.logins.push({ kind: 'authenticated', tokens: tokens('b') });
        api.users.push(BOB);
        await loginWithCredentials(state, context, CREDENTIALS);

        expect(persistence.operations).toStrictEqual(['load', 'clear@1', 'save@2:access-b']);
    });

    it.each([
        ['another sign-in', REJECTED, tokens('b'), OTHER, { kind: 'superseded' }, null],
        ['a rotation', REJECTED, tokens('b'), HELD, { kind: 'refreshed' }, ALICE],
        ['a sign-out', { kind: 'interactionRequired', pending: PENDING }, null, OTHER, { kind: 'superseded' }, null],
    ] as const)(
        'adopts %s persisted during a refused request instead of clearing',
        async (_label, result, written, lineage, outcome, user) => {
            const { state, api, persistence, context } = await signedIn(tokens('a'));
            const response = deferred<RefreshResult>();
            api.refreshes.push(response.promise);

            const refresh = refreshSession(state, context);

            await flush();
            persistence.write(written, lineage);
            response.resolve(result);

            await expect(refresh).resolves.toStrictEqual(outcome);
            expect(state.accessToken).toBe(written?.accessToken ?? null);
            expect(state.user).toStrictEqual(user);
            expect(persistence.operations).toStrictEqual(['load', 'clear@1']);
            expect(persistence.snapshot.revision).toBe(2);
        },
    );

    it.each([
        ['a rejection', REJECTED],
        ['a return to pending', { kind: 'interactionRequired', pending: PENDING }],
    ] as const)(
        'reports a failure when persistence cannot be cleared on %s, never re-adopting the refused pair',
        async (_label, result) => {
            const { state, api, persistence, context } = await signedIn(tokens('a'));
            const failure = new Error('unavailable');
            persistence.clearFailure = failure;
            api.refreshes.push(result);

            await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'failed', error: failure });
            expect(state).toStrictEqual(createInitialSessionState());

            await hydrateSession(state, context);

            expect(state).toStrictEqual(createInitialSessionState());
            expect(persistence.snapshot).toStrictEqual({ revision: 1, session: persisted('a') });
        },
    );

    it.each([
        ['a rotation', { kind: 'refreshed', tokens: tokens('b') }],
        ['a transient failure', { kind: 'retryable', error: null }],
    ] as const)('is superseded by a sign-out during the request, whatever it answers: %s', async (_label, result) => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const response = deferred<RefreshResult>();
        api.refreshes.push(response.promise);

        const refresh = refreshSession(state, context);

        await flush();
        const logout = logoutSession(state, context);

        response.resolve(result);
        await logout;

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['load', 'clear@1', 'load']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: null });
        expect(api.logoutCalls).toStrictEqual([tokens('a')]);
    });

    it('is superseded by a sign-out while the new pair persists', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveGate = gate.promise;

        const refresh = refreshSession(state, context);

        await flush();
        const logout = logoutSession(state, context);

        gate.resolve(undefined);
        await logout;

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['load', 'save@1:access-b', 'clear@2', 'load']);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, session: null });
    });

    it('is superseded by a sign-out while a failed persist settles', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveGate = gate.promise;
        persistence.saveFailure = new Error('quota');

        const refresh = refreshSession(state, context);

        await flush();
        const logout = logoutSession(state, context);

        gate.resolve(undefined);
        await logout;

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual(createInitialSessionState());

        await hydrateSession(state, context);

        expect(persistence.operations.at(-1)).toBe('load');
    });

    it('is superseded by another context while the new pair persists', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveGate = gate.promise;

        const refresh = refreshSession(state, context);

        await flush();
        const clear = clearSession(state, context);

        persistence.write(tokens('elsewhere'));
        gate.resolve(undefined);
        await clear;

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['load', 'save@1:access-b', 'clear@1', 'clear@2']);
    });

    it.each([
        ['clears', null],
        ['fails to clear', new Error('unavailable')],
    ])('is superseded by a sign-out while the refused session %s', async (_label, failure) => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push(REJECTED);
        persistence.clearGate = gate.promise;
        persistence.clearFailure = failure;

        const refresh = refreshSession(state, context);

        await flush();
        persistence.write(tokens('b'));
        const logout = logoutSession(state, context);

        gate.resolve(undefined);
        await logout;

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['load', 'clear@1', 'clear@1', 'clear@2', 'load']);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, session: null });
    });

    it('runs every exchange under the context exchange lock', async () => {
        const { state, api, context } = await signedIn(tokens('a'));
        const exchangeLock = new CountingLock();
        const locked = { ...context, exchangeLock };
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        api.logins.push({ kind: 'authenticated', tokens: tokens('c') });
        api.users.push(BOB);

        await refreshSession(state, locked);
        await loginWithCredentials(state, locked, CREDENTIALS);
        await logoutSession(state, locked);

        expect(exchangeLock.runs).toBe(3);
        expect(api.calls).toStrictEqual(['refresh', 'login', 'currentUser', 'logout']);
    });
});

describe('logoutSession', () => {
    it('clears the session, then signs it out server-side with its captured tokens', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));

        const logout = logoutSession(state, context);

        expect(state).toStrictEqual(createInitialSessionState());

        await logout;

        expect(api.logoutCalls).toStrictEqual([tokens('a')]);
        expect(persistence.operations).toStrictEqual(['clear@1', 'load']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: null });
    });

    it('clears the state and the store at once while the server never answers', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        api.logouts.push(new Promise<undefined>(() => undefined));

        void logoutSession(state, context);
        await flush();

        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: null });
        expect(api.logoutCalls).toStrictEqual([tokens('a')]);

        await clearSession(state, context);

        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.snapshot).toStrictEqual({ revision: 3, session: null });
    });

    it('makes no request when the state holds no session', async () => {
        const { state, api, persistence, context } = fixture();

        await logoutSession(state, context);

        expect(api.calls).toStrictEqual([]);
        expect(persistence.operations).toStrictEqual(['clear@0']);
    });

    it('clears the session even when the server cannot be reached', async () => {
        const { state, api, context } = await signedIn(tokens('a'));
        api.logouts.push(new NetworkError('offline'));

        await logoutSession(state, context);

        expect(state).toStrictEqual(createInitialSessionState());
    });

    it('clears whatever session another context persisted meanwhile', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        persistence.write(tokens('b'));

        await logoutSession(state, context);

        expect(persistence.operations).toStrictEqual(['clear@1', 'clear@2', 'load']);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, session: null });
        expect(api.logoutCalls).toStrictEqual([tokens('a')]);
    });

    it('skips the request once another context has written since the clear', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        persistence.loadGate = gate.promise;

        const logout = logoutSession(state, context);

        await flush();
        persistence.write(tokens('b'));
        gate.resolve(undefined);
        await logout;

        expect(api.calls).toStrictEqual([]);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, session: persisted('b', OTHER) });
    });

    it('skips the request when the store cannot be read, failing closed', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        persistence.clearGate = gate.promise;

        const logout = logoutSession(state, context);

        persistence.loadFailure = new Error('unreadable');
        gate.resolve(undefined);

        await expect(logout).resolves.toBeUndefined();
        expect(api.calls).toStrictEqual([]);
    });

    it('signs the session out server-side, then rethrows, when the store cannot be cleared', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const failure = new Error('unavailable');
        persistence.clearFailure = failure;

        await expect(logoutSession(state, context)).rejects.toBe(failure);
        expect(state).toStrictEqual(createInitialSessionState());
        expect(api.logoutCalls).toStrictEqual([tokens('a')]);
    });

    it('skips the request, then rethrows, when the store moved on and cannot be cleared', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const failure = new Error('unavailable');
        persistence.write(tokens('b'));
        persistence.clearFailure = failure;

        await expect(logoutSession(state, context)).rejects.toBe(failure);
        expect(api.calls).toStrictEqual([]);
    });

    it('skips the request when a sign-in landed in this state before the clear was written', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('b') });
        api.users.push(BOB);
        persistence.clearGate = gate.promise;

        const logout = logoutSession(state, context);
        const login = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        persistence.write(tokens('elsewhere'));
        gate.resolve(undefined);
        await logout;

        await expect(login).resolves.toStrictEqual({ kind: 'authenticated' });
        expect(api.calls).toStrictEqual(['login', 'currentUser']);
        expect(persistence.operations).toStrictEqual(['clear@1', 'save@1:access-b', 'save@2:access-b']);
        expect(state).toStrictEqual({ ...tokens('b'), user: BOB });
    });

    it('lets a sign-in started during the server call land once it settles', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const response = deferred<undefined>();
        api.logouts.push(response.promise);
        api.logins.push({ kind: 'authenticated', tokens: tokens('b') });
        api.users.push(BOB);

        const logout = logoutSession(state, context);

        await flush();
        const login = loginWithCredentials(state, context, CREDENTIALS);

        await flush();

        expect(api.calls).toStrictEqual(['logout']);

        response.resolve(undefined);
        await logout;

        await expect(login).resolves.toStrictEqual({ kind: 'authenticated' });
        expect(api.loginCalls[0]?.refreshToken).toBeNull();
        expect(state).toStrictEqual({ ...tokens('b'), user: BOB });
        expect(persistence.snapshot).toStrictEqual({ revision: 3, session: persisted('b', 'lineage-1') });
    });

    it('leaves the state signed out when a sign-in started during the server call ends pending', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const response = deferred<undefined>();
        api.logouts.push(response.promise);
        api.logins.push({ kind: 'interactionRequired', pending: PENDING });

        const logout = logoutSession(state, context);
        const login = loginWithCredentials(state, context, CREDENTIALS);

        response.resolve(undefined);
        await logout;

        await expect(login).resolves.toStrictEqual({ kind: 'interactionRequired', pending: PENDING });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: null });
    });

    it.each([
        ['another sign-in started', 'login'],
        ['a clear', 'clear'],
    ] as const)(
        'signs out when %s while a session whose refresh credential travels in a cookie was issued',
        async (_label, overtaking) => {
            const { state, api, persistence, context } = await signedIn(tokens('a', { refreshToken: null }));
            const response = deferred<LoginResult>();
            api.logins.push(response.promise, new HttpError(422, 'Invalid'));

            const first = loginWithCredentials(state, context, CREDENTIALS);

            await flush();
            const second =
                overtaking === 'login'
                    ? loginWithCredentials(state, context, CREDENTIALS)
                    : clearSession(state, context);

            response.resolve({ kind: 'authenticated', tokens: tokens('b', { refreshToken: null }) });

            await expect(first).resolves.toStrictEqual({ kind: 'superseded' });
            expect(state).toStrictEqual(createInitialSessionState());
            expect(persistence.snapshot.session).toBeNull();
            expect(api.logoutCalls).toStrictEqual([tokens('b', { refreshToken: null })]);

            await second.catch(() => undefined);

            expect(state).toStrictEqual(createInitialSessionState());
            expect(api.refreshCalls).toStrictEqual([]);
        },
    );

    it('discards a pending answer to an overtaken sign-in, leaving the held session alone', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a', { refreshToken: null }));
        const response = deferred<LoginResult>();
        api.logins.push(response.promise, new HttpError(422, 'Invalid'));

        const first = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        const second = loginWithCredentials(state, context, CREDENTIALS);

        response.resolve({ kind: 'interactionRequired', pending: PENDING });

        await expect(first).resolves.toStrictEqual({ kind: 'superseded' });
        await expect(second).rejects.toThrow('Invalid');
        expect(state).toStrictEqual({ ...tokens('a', { refreshToken: null }), user: ALICE });
        expect(persistence.operations).toStrictEqual([]);
        expect(api.logoutCalls).toStrictEqual([]);
    });

    it('signs the state out when signing an overtaken cookie sign-in out throws', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a', { refreshToken: null }));
        const response = deferred<LoginResult>();
        api.logins.push(response.promise, new HttpError(422, 'Invalid'));
        api.logout = (): Promise<void> => {
            throw new Error('offline');
        };

        const first = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        const second = loginWithCredentials(state, context, CREDENTIALS);

        response.resolve({ kind: 'authenticated', tokens: tokens('b', { refreshToken: null }) });

        await expect(first).resolves.toStrictEqual({ kind: 'superseded' });
        await expect(second).rejects.toThrow('Invalid');
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: null });
    });

    it('still reports an overtaken cookie sign-in as superseded when the store cannot be cleared', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a', { refreshToken: null }));
        const response = deferred<LoginResult>();
        api.logins.push(response.promise, new HttpError(422, 'Invalid'));

        const first = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        const second = loginWithCredentials(state, context, CREDENTIALS);

        persistence.clearFailure = new Error('unavailable');
        response.resolve({ kind: 'authenticated', tokens: tokens('b', { refreshToken: null }) });

        await expect(first).resolves.toStrictEqual({ kind: 'superseded' });
        await expect(second).rejects.toThrow('Invalid');
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.snapshot).toStrictEqual({
            revision: 1,
            session: { lineage: HELD, tokens: tokens('a', { refreshToken: null }) },
        });
    });

    it('sends only the later of two sign-ins started together', async () => {
        const { state, api, context } = fixture();
        api.logins.push({ kind: 'authenticated', tokens: tokens('b') });
        api.users.push(BOB);

        const first = loginWithCredentials(state, context, CREDENTIALS);
        const second = loginWithCredentials(state, context, CREDENTIALS);

        await expect(first).resolves.toStrictEqual({ kind: 'superseded' });
        await expect(second).resolves.toStrictEqual({ kind: 'authenticated' });
        expect(api.calls).toStrictEqual(['login', 'currentUser']);
    });

    it('makes no refresh once the sign-out has started', async () => {
        const { state, api, context } = await signedIn(tokens('a'));

        const logout = logoutSession(state, context);

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'superseded' });
        await logout;

        expect(api.calls).toStrictEqual(['logout']);
    });
});

describe('clearSession', () => {
    it('clears the state before persistence settles', async () => {
        const { state, persistence, context } = await signedIn(tokens('a'));

        const clear = clearSession(state, context);

        expect(state).toStrictEqual(createInitialSessionState());

        await clear;

        expect(persistence.snapshot).toStrictEqual({ revision: 2, session: null });
    });

    it('propagates a persistence failure', async () => {
        const { state, persistence, context } = await signedIn(tokens('a'));
        persistence.clearFailure = new Error('unavailable');

        await expect(clearSession(state, context)).rejects.toThrow('unavailable');
    });

    it('stops clearing over another context once a sign-in lands', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('b') });
        api.users.push(BOB);
        persistence.clearGate = gate.promise;

        const clear = clearSession(state, context);
        const login = loginWithCredentials(state, context, CREDENTIALS);

        await flush();
        persistence.write(tokens('elsewhere'));
        gate.resolve(undefined);
        await clear;

        await expect(login).resolves.toStrictEqual({ kind: 'authenticated' });
        expect(persistence.operations).toStrictEqual(['clear@1', 'save@1:access-b', 'save@2:access-b']);
    });
});

describe('rehydrateSessionUser', () => {
    it('does nothing when signed out', async () => {
        const { state, api, context } = fixture();

        await rehydrateSessionUser(state, context);

        expect(api.calls).toStrictEqual([]);
    });

    it('does nothing when the user is already loaded', async () => {
        const { state, api, context } = await signedIn(tokens('a'));

        await rehydrateSessionUser(state, context);

        expect(api.calls).toStrictEqual([]);
    });

    it('loads the user', async () => {
        const { state, api, context } = await signedIn(tokens('a'));
        state.user = null;
        api.users.push(BOB);

        await rehydrateSessionUser(state, context);

        expect(state.user).toStrictEqual(BOB);
    });

    it('shares one request between concurrent callers, then allows another', async () => {
        const { state, api, context } = await signedIn(tokens('a'));
        state.user = null;
        api.users.push(new Error('failed'));

        await Promise.all([rehydrateSessionUser(state, context), rehydrateSessionUser(state, context)]);

        expect(api.calls).toStrictEqual(['currentUser']);
        expect(state.user).toBeNull();

        api.users.push(ALICE);
        await rehydrateSessionUser(state, context);

        expect(api.calls).toStrictEqual(['currentUser', 'currentUser']);
        expect(state.user).toStrictEqual(ALICE);
    });

    it('discards a user that arrives after the session was cleared', async () => {
        const { state, api, context } = await signedIn(tokens('a'));
        const user = deferred<SessionUser>();
        state.user = null;
        api.users.push(user.promise);

        const rehydrate = rehydrateSessionUser(state, context);

        await clearSession(state, context);
        user.resolve(ALICE);
        await rehydrate;

        expect(state.user).toBeNull();
    });

    it('gives a replacing session its own request, which the earlier one leaves in place', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const first = deferred<SessionUser>();
        const second = deferred<SessionUser>();
        state.user = null;
        api.users.push(first.promise, second.promise);

        const earlier = rehydrateSessionUser(state, context);

        persistence.write(tokens('b'));
        await hydrateSession(state, context);
        const later = rehydrateSessionUser(state, context);

        first.resolve(ALICE);
        await earlier;
        const joined = rehydrateSessionUser(state, context);

        second.resolve(BOB);
        await Promise.all([later, joined]);

        expect(api.calls).toStrictEqual(['currentUser', 'currentUser']);
        expect(state).toStrictEqual({ ...tokens('b'), user: BOB });
    });

    it('keeps the request in flight across a rotation adopted from another context', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const user = deferred<SessionUser>();
        state.user = null;
        api.users.push(user.promise);

        const earlier = rehydrateSessionUser(state, context);

        persistence.write(tokens('b'), HELD);
        await hydrateSession(state, context);
        const joined = rehydrateSessionUser(state, context);

        user.resolve(ALICE);
        await Promise.all([earlier, joined]);

        expect(api.calls).toStrictEqual(['currentUser']);
        expect(state).toStrictEqual({ ...tokens('b'), user: ALICE });
    });
});

describe('sessionIdentity', () => {
    it('is null while the state holds no session', () => {
        const { state } = fixture();

        expect(sessionIdentity(state)).toBeNull();
    });

    it('stays the same across rotations, persisted or not', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const identity = sessionIdentity(state);
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('c') });

        await refreshSession(state, context);
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);

        expect(identity).not.toBeNull();
        expect(sessionIdentity(state)).toBe(identity);
    });

    it('changes with every sign-in', async () => {
        const { state, api, context } = await signedIn(tokens('a'));
        const identity = sessionIdentity(state);
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(ALICE);

        await loginWithCredentials(state, context, CREDENTIALS);

        expect(sessionIdentity(state)).not.toBeNull();
        expect(sessionIdentity(state)).not.toBe(identity);
    });

    it.each([
        ['changes when another sign-in is adopted', OTHER, false],
        ['stays the same when a rotation is adopted', HELD, true],
    ])('%s from another context', async (_label, lineage, same) => {
        const { state, persistence, context } = await signedIn(tokens('a'));
        const identity = sessionIdentity(state);
        persistence.write(tokens('a'), lineage);

        await hydrateSession(state, context);

        expect(sessionIdentity(state)).not.toBeNull();
        expect(sessionIdentity(state) === identity).toBe(same);
    });

    it.each([
        ['clear', clearSession],
        ['sign-out', logoutSession],
    ])('is null as soon as a %s starts', async (_label, transition) => {
        const { state, context } = await signedIn(tokens('a'));

        const settled = transition(state, context);

        expect(sessionIdentity(state)).toBeNull();

        await settled;
    });
});

describe('type contract', () => {
    it('refuses a context whose gateway returns a narrower user than the state holds', () => {
        const state = createInitialSessionState<AdminUser>();
        const { context } = fixture();

        /** Never run: only type-checked. */
        const transitions = (): unknown => [
            // @ts-expect-error the context's users lack the state's role
            hydrateSession(state, context),
            // @ts-expect-error the context's users lack the state's role
            loginWithCredentials(state, context, CREDENTIALS),
            // @ts-expect-error the context's users lack the state's role
            refreshSession(state, context),
            // @ts-expect-error the context's users lack the state's role
            logoutSession(state, context),
            // @ts-expect-error the context's users lack the state's role
            clearSession(state, context),
            // @ts-expect-error the context's users lack the state's role
            rehydrateSessionUser(state, context),
        ];

        expect(transitions).toBeTypeOf('function');
    });

    it('accepts a context whose gateway returns the state user type', () => {
        const state = createInitialSessionState<AdminUser>();
        const context: SessionCoreContext<AdminUser> = {
            ...fixture().context,
            api: {} as SessionApi<AdminUser>,
        };

        /** Never run: only type-checked. */
        const transitions = (): unknown => [
            hydrateSession(state, context),
            loginWithCredentials(state, context, CREDENTIALS),
            refreshSession(state, context),
        ];

        expect(transitions).toBeTypeOf('function');
    });
});
