/**
 * Unit tests for the session core transitions.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { HttpError, NetworkError } from '../http/http-error';
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
import type { LoginResult, RefreshResult } from './session-outcomes';
import type { SessionClearResult, SessionPersistence, SessionSaveResult, SessionSnapshot } from './session-persistence';
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
}

/** Credentials signing in with a one-time code. */
interface CodeCredentials {
    /** The phone number. */
    readonly phone: string;

    /** The one-time code. */
    readonly code: string;
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

    /** The refresh token presented by every logout call. */
    readonly logoutCalls: Array<string | null> = [];

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
    login(credentials: C, device: SessionDevice): Promise<LoginResult> {
        this.calls.push('login');
        this.loginCalls.push({ credentials, device });

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
    async logout(refreshToken: string | null): Promise<void> {
        this.calls.push('logout');
        this.logoutCalls.push(refreshToken);

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
 * injectable failures and gates. A gated write compares revisions once its gate
 * opens, as a write waiting on a lock would.
 */
class FakePersistence implements SessionPersistence {
    /** The persisted snapshot. */
    snapshot: SessionSnapshot = { revision: 0, tokens: null };

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
     * Persist the tokens when the snapshot is at the expected revision.
     */
    async saveIf(expectedRevision: number, tokens: SessionTokens): Promise<SessionSaveResult> {
        this.operations.push(`save@${expectedRevision}:${tokens.accessToken}`);
        await this.#pass('saveGate');
        this.#fail('saveFailure');

        if (this.snapshot.revision !== expectedRevision) {
            return { status: 'changed', current: this.snapshot };
        }

        return { status: 'saved', revision: this.write(tokens) };
    }

    /**
     * Clear the snapshot when it is at the expected revision.
     */
    async clearIf(expectedRevision: number): Promise<SessionClearResult> {
        this.operations.push(`clear@${expectedRevision}`);
        await this.#pass('clearGate');
        this.#fail('clearFailure');

        if (this.snapshot.revision !== expectedRevision) {
            return { status: 'changed', current: this.snapshot };
        }

        return { status: 'cleared', revision: this.write(null) };
    }

    /**
     * Write a snapshot at the next revision, as another context would.
     *
     * @param tokens - the tokens to write, or null to clear
     */
    write(tokens: SessionTokens | null): number {
        this.snapshot = { revision: this.snapshot.revision + 1, tokens };

        return this.snapshot.revision;
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
 * Build a signed-out fixture over an empty store.
 */
function fixture(): Fixture {
    const state = createInitialSessionState();
    const api = new FakeSessionApi();
    const persistence = new FakePersistence();

    return { state, api, persistence, context: { api, persistence, device: () => DEVICE } };
}

/**
 * Build a fixture hydrated from a store holding the given tokens at the given
 * revision, with Alice loaded and the operation log emptied.
 */
async function signedIn(signedIn: SessionTokens, revision = 1): Promise<Fixture> {
    const built = fixture();

    built.persistence.snapshot = { revision, tokens: signedIn };
    await hydrateSession(built.state, built.context);
    built.state.user = ALICE;
    built.persistence.operations.length = 0;

    return built;
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
        persistence.snapshot = { revision: 1, tokens: tokens('a') };

        await hydrateSession(state, context);

        expect(state).toStrictEqual({ ...tokens('a'), user: null });
        expect(persistence.operations).toStrictEqual(['load']);
    });

    it('leaves a signed-out state alone when nothing is persisted', async () => {
        const { state, context } = fixture();

        await hydrateSession(state, context);

        expect(state).toStrictEqual(createInitialSessionState());
    });

    it('keeps the state, user included, when the persisted revision is its own', async () => {
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

    it('adopts a session another context persisted, dropping the user', async () => {
        const { state, persistence, context } = await signedIn(tokens('a'));
        persistence.write(tokens('b'));

        await hydrateSession(state, context);

        expect(state).toStrictEqual({ ...tokens('b'), user: null });
    });

    it('signs the state out, never adopting the older pair, when the store was reset beneath it', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'), 3);
        persistence.snapshot = { revision: 1, tokens: tokens('old') };
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

    it('supersedes an in-flight refresh when another context rotated the session', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const response = deferred<RefreshResult>();
        api.refreshes.push(response.promise);

        const refresh = refreshSession(state, context);

        persistence.write(tokens('b'));
        await hydrateSession(state, context);
        response.resolve({ kind: 'refreshed', tokens: tokens('c') });

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(tokensOf(state)).toStrictEqual(tokens('b'));
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: tokens('b') });
    });

    it('supersedes an in-flight refresh when the persisted session is gone', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const response = deferred<RefreshResult>();
        api.refreshes.push(response.promise);

        const refresh = refreshSession(state, context);

        persistence.write(null);
        await hydrateSession(state, context);
        response.resolve({ kind: 'refreshed', tokens: tokens('b') });

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state.accessToken).toBeNull();
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: null });
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
        expect(api.calls).toStrictEqual(['login']);
    });

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

        expect(persistence.operations).toStrictEqual(['save@1:access-b', 'clear@2']);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, tokens: null });
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

        expect(persistence.operations).toStrictEqual(['save@1:access-b', 'save@1:access-b']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: tokens('b') });
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
        expect(persistence.snapshot).toStrictEqual({ revision: 1, tokens: tokens('a') });
    });

    it('adopts a newer session over a rotated pair that could not be persisted', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);
        persistence.write(tokens('c'));

        await hydrateSession(state, context);

        expect(state).toStrictEqual({ ...tokens('c'), user: null });

        await hydrateSession(state, context);

        expect(persistence.operations.at(-1)).toBe('load');
    });
});

describe('loginWithCredentials', () => {
    it('signs in, persists the session, then loads the user', async () => {
        const { state, api, persistence, context } = fixture();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(ALICE);

        await expect(loginWithCredentials(state, context, CREDENTIALS)).resolves.toStrictEqual({
            kind: 'authenticated',
        });

        expect(api.loginCalls).toStrictEqual([{ credentials: CREDENTIALS, device: DEVICE }]);
        expect(api.calls).toStrictEqual(['login', 'currentUser']);
        expect(persistence.operations).toStrictEqual(['save@0:access-a']);
        expect(persistence.snapshot).toStrictEqual({ revision: 1, tokens: tokens('a') });
        expect(state).toStrictEqual({ ...tokens('a'), user: ALICE });
    });

    it('holds the persisted tokens in state while the user loads, without the previous user', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('old'));
        const user = deferred<SessionUser>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(user.promise);

        const login = loginWithCredentials(state, context, CREDENTIALS);

        await flush();

        expect(state).toStrictEqual({ ...tokens('a'), user: null });
        expect(persistence.snapshot.tokens).toStrictEqual(tokens('a'));

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

        await loginWithCredentials(state, { api, persistence, device: () => DEVICE }, { phone: '+44', code: '123' });

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
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: tokens('a') });

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
        expect(persistence.snapshot).toStrictEqual({ revision: 3, tokens: null });
    });

    it('rolls the session back when it cannot be persisted', async () => {
        const { state, api, persistence, context } = fixture();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(ALICE);
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
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'clear@1']);
        expect(api.logoutCalls).toStrictEqual(['refresh-a']);
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
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'clear@1']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: null });
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
        expect(persistence.operations).toStrictEqual(['load', 'clear@0']);
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
        expect(state).toStrictEqual({ ...tokens('b'), user: BOB });
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: tokens('b') });
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'save@1:access-b']);
    });

    it('lets the later of two overlapping sign-ins win when the earlier answers first', async () => {
        const { state, api, persistence, context } = fixture();
        const earlier = deferred<LoginResult>();
        const later = deferred<LoginResult>();
        api.logins.push(earlier.promise, later.promise);
        api.users.push(BOB);

        const first = loginWithCredentials(state, context, CREDENTIALS);
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
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'save@1:access-b']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: tokens('b') });
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
        expect(persistence.operations).toStrictEqual(['save@0:access-a', 'clear@0', 'clear@1']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: null });
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
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: null });
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
});

describe('refreshSession', () => {
    it('presents the refresh token, persists the new pair, then applies it', async () => {
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
        expect(persistence.operations).toStrictEqual(['save@1:access-b']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: tokens('b') });
        expect(state).toStrictEqual({ ...tokens('b'), user: ALICE });
    });

    it('refreshes without a held refresh token, as with a cookie transport', async () => {
        const { state, api, context } = await signedIn(tokens('a', { refreshToken: null }));
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b', { refreshToken: null }) });

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(api.refreshCalls).toStrictEqual([null]);
        expect(state.accessToken).toBe('access-b');
    });

    it('keeps the new pair in memory and reports a failure when it cannot be persisted', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const failure = new Error('quota');
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveFailure = failure;

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'failed', error: failure });
        expect(state).toStrictEqual({ ...tokens('b'), user: ALICE });
        expect(persistence.snapshot).toStrictEqual({ revision: 1, tokens: tokens('a') });
    });

    it('persists the unsaved pair, then the next rotation over it', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('c') });
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(api.refreshCalls).toStrictEqual(['refresh-a', 'refresh-b']);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, tokens: tokens('c') });

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
        expect(persistence.operations).toStrictEqual(['save@1:access-b', 'save@1:access-b']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: tokens('b') });

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

    it('adopts a newer session instead of persisting an unsaved pair, without asking the server', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);
        persistence.write(tokens('c'));

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(api.refreshCalls).toStrictEqual(['refresh-a']);
        expect(state).toStrictEqual({ ...tokens('c'), user: null });
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
        expect(persistence.operations).toStrictEqual(['save@1:access-b', 'save@1:access-b', 'save@2:access-c']);
    });

    it('clears a refused session at the revision its retried save produced', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        api.refreshes.push(REJECTED);
        persistence.saveFailure = new Error('quota');
        await refreshSession(state, context);

        await expect(refreshSession(state, context)).resolves.toStrictEqual(REJECTED);
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['save@1:access-b', 'save@1:access-b', 'clear@2']);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, tokens: null });
    });

    it('adopts the session another context persisted while the rotation waited', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveGate = gate.promise;

        const refresh = refreshSession(state, context);

        await flush();
        persistence.write(tokens('elsewhere'));
        gate.resolve(undefined);

        await expect(refresh).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(state).toStrictEqual({ ...tokens('elsewhere'), user: null });
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: tokens('elsewhere') });
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
        expect(persistence.operations).toStrictEqual([]);
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
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: null });
    });

    it.each([
        ['a rejection', REJECTED],
        ['a return to pending', { kind: 'interactionRequired', pending: PENDING }],
    ] as const)('clears the persisted session on %s', async (_label, result) => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        api.refreshes.push(result);

        await expect(refreshSession(state, context)).resolves.toStrictEqual(result);
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['clear@1']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: null });

        await hydrateSession(state, context);

        expect(state).toStrictEqual(createInitialSessionState());
    });

    it.each([
        ['a rejection', REJECTED],
        ['a return to pending', { kind: 'interactionRequired', pending: PENDING }],
    ] as const)('adopts a session another context persisted instead of clearing on %s', async (_label, result) => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        persistence.write(tokens('b'));
        api.refreshes.push(result);

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(state).toStrictEqual({ ...tokens('b'), user: null });
        expect(persistence.operations).toStrictEqual(['clear@1']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: tokens('b') });
    });

    it('reports the rejection when another context already cleared the session', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        persistence.write(null);
        api.refreshes.push(REJECTED);

        await expect(refreshSession(state, context)).resolves.toStrictEqual(REJECTED);
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: null });
    });

    it('signs out without a write when a signed-out refresh is rejected', async () => {
        const { state, api, persistence, context } = fixture();
        const login = deferred<LoginResult>();
        api.refreshes.push(REJECTED);
        api.logins.push(login.promise);
        api.users.push(ALICE);

        const signingIn = loginWithCredentials(state, context, CREDENTIALS);

        await expect(refreshSession(state, context)).resolves.toStrictEqual(REJECTED);
        login.resolve({ kind: 'authenticated', tokens: tokens('a') });

        await expect(signingIn).resolves.toStrictEqual({ kind: 'authenticated' });
        expect(persistence.operations).toStrictEqual(['clear@0', 'save@1:access-a']);
    });

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
            expect(persistence.snapshot).toStrictEqual({ revision: 1, tokens: tokens('a') });
        },
    );

    it('keeps the session this context rotated since the refused refresh started', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const refused = deferred<RefreshResult>();
        api.refreshes.push(refused.promise);
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });

        const stale = refreshSession(state, context);

        await refreshSession(state, context);
        refused.resolve(REJECTED);

        await expect(stale).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(state).toStrictEqual({ ...tokens('b'), user: ALICE });
        expect(persistence.operations).toStrictEqual(['save@1:access-b', 'clear@1']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: tokens('b') });
    });

    it('is superseded by a sign-out during the refresh request, never re-applying tokens', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const response = deferred<RefreshResult>();
        api.refreshes.push(response.promise);

        const refresh = refreshSession(state, context);

        await logoutSession(state, context);
        response.resolve({ kind: 'refreshed', tokens: tokens('b') });

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['clear@1']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: null });
    });

    it('is superseded by a sign-out during the refresh request, whatever the request answered', async () => {
        const { state, api, context } = await signedIn(tokens('a'));
        const response = deferred<RefreshResult>();
        api.refreshes.push(response.promise);

        const refresh = refreshSession(state, context);

        await logoutSession(state, context);
        response.resolve({ kind: 'retryable', error: null });

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
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
        expect(persistence.operations).toStrictEqual(['save@1:access-b', 'clear@2']);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, tokens: null });
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
        expect(persistence.operations).toStrictEqual(['save@1:access-b', 'clear@1', 'clear@2']);
    });

    it('is superseded by a sign-out while the refused session clears', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push(REJECTED);
        persistence.clearGate = gate.promise;
        persistence.write(tokens('b'));

        const refresh = refreshSession(state, context);

        await flush();
        const logout = logoutSession(state, context);

        gate.resolve(undefined);
        await logout;

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['clear@1', 'clear@1', 'clear@2']);
    });

    it('is superseded by a sign-out while the refused session fails to clear', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push(REJECTED);
        persistence.clearGate = gate.promise;
        persistence.clearFailure = new Error('unavailable');

        const refresh = refreshSession(state, context);

        await flush();
        const logout = logoutSession(state, context);

        gate.resolve(undefined);
        await logout;

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: null });
    });

    it.each([
        ['rotation', { kind: 'refreshed', tokens: tokens('b') }],
        ['refusal', REJECTED],
    ] as const)('skips the %s write when a sign-out overtook it before it ran', async (_label, result) => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const gate = deferred<undefined>();
        persistence.loadGate = gate.promise;
        api.refreshes.push(result);

        const hydrate = hydrateSession(state, context);
        const refresh = refreshSession(state, context);

        await flush();
        const logout = logoutSession(state, context);

        gate.resolve(undefined);
        await Promise.all([hydrate, logout]);

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(persistence.operations).toStrictEqual(['load', 'clear@1']);
    });
});

describe('logoutSession', () => {
    it('signs out server-side with the refresh token, then clears the session', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));

        await logoutSession(state, context);

        expect(api.logoutCalls).toStrictEqual(['refresh-a']);
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['clear@1']);
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: null });
    });

    it('clears the session even when the server cannot be reached', async () => {
        const { state, api, context } = await signedIn(tokens('a'));
        api.logouts.push(new NetworkError('offline'));

        await logoutSession(state, context);

        expect(state).toStrictEqual(createInitialSessionState());
    });

    it('clears whatever session another context persisted meanwhile', async () => {
        const { state, persistence, context } = await signedIn(tokens('a'));
        persistence.write(tokens('b'));

        await logoutSession(state, context);

        expect(persistence.operations).toStrictEqual(['clear@1', 'clear@2']);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, tokens: null });
    });

    it('leaves a sign-in that started during the server call in place', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const response = deferred<undefined>();
        api.logouts.push(response.promise);

        const logout = logoutSession(state, context);

        api.logins.push({ kind: 'authenticated', tokens: tokens('b') });
        api.users.push(BOB);
        await loginWithCredentials(state, context, CREDENTIALS);
        response.resolve(undefined);
        await logout;

        expect(state).toStrictEqual({ ...tokens('b'), user: BOB });
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: tokens('b') });
    });

    it('clears a rotation adopted from another context during the server call', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const response = deferred<undefined>();
        api.logouts.push(response.promise);

        const logout = logoutSession(state, context);

        persistence.write(tokens('b'));
        await hydrateSession(state, context);
        response.resolve(undefined);
        await logout;

        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['load', 'clear@2']);
        expect(persistence.snapshot).toStrictEqual({ revision: 3, tokens: null });
    });

    it('clears the session when a sign-in started during the server call ends pending', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const response = deferred<undefined>();
        api.logouts.push(response.promise);
        api.logins.push({ kind: 'interactionRequired', pending: PENDING });

        const logout = logoutSession(state, context);

        await loginWithCredentials(state, context, CREDENTIALS);
        response.resolve(undefined);
        await logout;

        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: null });
    });

    it('leaves a sign-in started during the server call to land after the clear', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const login = deferred<LoginResult>();
        api.logins.push(login.promise);
        api.users.push(BOB);

        const logout = logoutSession(state, context);
        const signingIn = loginWithCredentials(state, context, CREDENTIALS);

        await logout;
        login.resolve({ kind: 'authenticated', tokens: tokens('b') });

        await expect(signingIn).resolves.toStrictEqual({ kind: 'authenticated' });
        expect(state).toStrictEqual({ ...tokens('b'), user: BOB });
        expect(persistence.operations).toStrictEqual(['clear@1', 'save@2:access-b']);
    });

    it('clears a pair rotated during the server call', async () => {
        const { state, api, persistence, context } = await signedIn(tokens('a'));
        const response = deferred<undefined>();
        api.logouts.push(response.promise);
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });

        const logout = logoutSession(state, context);

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'refreshed' });

        response.resolve(undefined);
        await logout;

        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['save@1:access-b', 'clear@2']);
    });

    it('propagates a persistence failure after clearing the state', async () => {
        const { state, persistence, context } = await signedIn(tokens('a'));
        persistence.clearFailure = new Error('unavailable');

        await expect(logoutSession(state, context)).rejects.toThrow('unavailable');
        expect(state).toStrictEqual(createInitialSessionState());
    });
});

describe('clearSession', () => {
    it('clears the state before persistence settles', async () => {
        const { state, persistence, context } = await signedIn(tokens('a'));

        const clear = clearSession(state, context);

        expect(state).toStrictEqual(createInitialSessionState());

        await clear;

        expect(persistence.snapshot).toStrictEqual({ revision: 2, tokens: null });
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

    it("changes when another context's session is adopted", async () => {
        const { state, persistence, context } = await signedIn(tokens('a'));
        const identity = sessionIdentity(state);
        persistence.write(tokens('a'));

        await hydrateSession(state, context);

        expect(sessionIdentity(state)).not.toBeNull();
        expect(sessionIdentity(state)).not.toBe(identity);
    });

    it('is null once the session is cleared', async () => {
        const { state, context } = await signedIn(tokens('a'));

        await clearSession(state, context);

        expect(sessionIdentity(state)).toBeNull();
    });

    it('stays the same throughout a sign-out until the session is cleared', async () => {
        const { state, api, context } = await signedIn(tokens('a'));
        const identity = sessionIdentity(state);
        const response = deferred<undefined>();
        api.logouts.push(response.promise);
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });

        const logout = logoutSession(state, context);

        expect(sessionIdentity(state)).toBe(identity);

        await refreshSession(state, context);
        state.user = ALICE;
        await flush();

        expect(sessionIdentity(state)).toBe(identity);

        response.resolve(undefined);
        await logout;

        expect(sessionIdentity(state)).toBeNull();
    });
});
