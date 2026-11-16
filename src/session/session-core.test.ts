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
} from './session-core';
import type { LoginResult, RefreshResult } from './session-outcomes';
import type { SessionPersistence } from './session-persistence';
import type { SessionState } from './session-state';
import type { SessionTokens } from './session-tokens';
import type { SessionUser } from './session-user';

/** A queued gateway outcome: a value, a failure, or a pending promise. */
type Queued<T> = T | Error | Promise<T>;

/**
 * Consume the next queued outcome.
 *
 * @param queue - the outcome queue
 * @returns a promise settling with the next outcome
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
 *
 * @returns the deferred promise
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
     *
     * @param credentials - the credentials
     * @param device - the device fingerprint
     * @returns the next queued login outcome
     */
    login(credentials: C, device: SessionDevice): Promise<LoginResult> {
        this.calls.push('login');
        this.loginCalls.push({ credentials, device });

        return take(this.logins);
    }

    /**
     * Record a refresh.
     *
     * @param refreshToken - the presented refresh token
     * @returns the next queued refresh outcome
     */
    refresh(refreshToken: string | null): Promise<RefreshResult> {
        this.calls.push('refresh');
        this.refreshCalls.push(refreshToken);

        return take(this.refreshes);
    }

    /**
     * Record a logout, resolving when nothing is queued.
     *
     * @param refreshToken - the presented refresh token
     * @returns the next queued logout outcome
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
     *
     * @returns the next queued user outcome
     */
    currentUser(): Promise<SessionUser> {
        this.calls.push('currentUser');

        return take(this.users);
    }
}

/**
 * An in-memory {@link SessionPersistence} fake recording each operation, with
 * injectable failures and gates.
 */
class FakePersistence implements SessionPersistence {
    /** The persisted snapshot. */
    snapshot: SessionTokens | null = null;

    /** Every operation, in order. */
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

    /**
     * Read the snapshot.
     *
     * @returns the snapshot
     */
    async load(): Promise<SessionTokens | null> {
        this.operations.push('load');
        await this.#pass(this.loadGate);
        this.loadGate = null;
        this.#fail('loadFailure');

        return this.snapshot;
    }

    /**
     * Replace the snapshot.
     *
     * @param tokens - the tokens to persist
     */
    async save(tokens: SessionTokens): Promise<void> {
        this.operations.push(`save:${tokens.accessToken}`);
        await this.#pass(this.saveGate);
        this.saveGate = null;
        this.#fail('saveFailure');
        this.snapshot = tokens;
    }

    /**
     * Remove the snapshot.
     */
    clear(): Promise<void> {
        return new Promise((resolve) => {
            this.operations.push('clear');
            this.#fail('clearFailure');
            this.snapshot = null;
            resolve();
        });
    }

    /**
     * Wait on a gate when one is set.
     *
     * @param gate - the gate, or null
     */
    async #pass(gate: Promise<void> | null): Promise<void> {
        if (gate !== null) {
            await gate;
        }
    }

    /**
     * Throw, once, the failure stored under the given field.
     *
     * @param field - the failure field
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

/**
 * Build a token set.
 *
 * @param suffix - distinguishes the tokens of one pair from another
 * @param overrides - fields replacing the defaults
 * @returns the tokens
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
 * Build a fixture, optionally signed in with the given tokens.
 *
 * @param signedIn - the tokens to start signed in with, persisted too
 * @returns the fixture
 */
function fixture(signedIn: SessionTokens | null = null): Fixture {
    const state = createInitialSessionState();
    const api = new FakeSessionApi();
    const persistence = new FakePersistence();

    if (signedIn !== null) {
        Object.assign(state, signedIn, { user: ALICE });
        persistence.snapshot = signedIn;
    }

    return { state, api, persistence, context: { api, persistence, device: () => DEVICE } };
}

/**
 * Read the token fields of the state.
 *
 * @param state - the session state
 * @returns the state's tokens
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
    await new Promise<void>((resolve) => {
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
        persistence.snapshot = tokens('a');

        await hydrateSession(state, context);

        expect(state).toStrictEqual({ ...tokens('a'), user: null });
    });

    it('leaves a signed-out state alone when nothing is persisted', async () => {
        const { state, context } = fixture();

        await hydrateSession(state, context);

        expect(state).toStrictEqual(createInitialSessionState());
    });

    it('signs the state out when the persisted session is gone', async () => {
        const { state, persistence, context } = fixture(tokens('a'));
        persistence.snapshot = null;

        await hydrateSession(state, context);

        expect(state).toStrictEqual(createInitialSessionState());
    });

    it('keeps the user when the persisted session was rotated', async () => {
        const { state, persistence, context } = fixture(tokens('a'));
        persistence.snapshot = tokens('b');

        await hydrateSession(state, context);

        expect(state).toStrictEqual({ ...tokens('b'), user: ALICE });
    });

    it('lets an in-flight refresh land when the persisted session was rotated', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        const response = deferred<RefreshResult>();
        api.refreshes.push(response.promise);

        const refresh = refreshSession(state, context);

        persistence.snapshot = tokens('b');
        await hydrateSession(state, context);
        response.resolve({ kind: 'refreshed', tokens: tokens('c') });

        await expect(refresh).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(tokensOf(state)).toStrictEqual(tokens('c'));
    });

    it('supersedes an in-flight refresh when the persisted session is gone', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        const response = deferred<RefreshResult>();
        api.refreshes.push(response.promise);

        const refresh = refreshSession(state, context);

        persistence.snapshot = null;
        await hydrateSession(state, context);
        response.resolve({ kind: 'refreshed', tokens: tokens('b') });

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state.accessToken).toBeNull();
        expect(persistence.snapshot).toBeNull();
    });

    it('does not supersede an in-flight sign-in when already signed out and nothing is persisted', async () => {
        const { state, api, context } = fixture();
        const response = deferred<LoginResult>();
        api.logins.push(response.promise);
        api.users.push(ALICE);

        const login = loginWithCredentials(state, context, CREDENTIALS);

        await hydrateSession(state, context);
        response.resolve({ kind: 'authenticated', tokens: tokens('a') });

        await expect(login).resolves.toStrictEqual({ kind: 'authenticated' });
    });

    it('supersedes an in-flight sign-in when another context signed in', async () => {
        const { state, api, persistence, context } = fixture();
        const response = deferred<LoginResult>();
        api.logins.push(response.promise);

        const login = loginWithCredentials(state, context, CREDENTIALS);

        persistence.snapshot = tokens('elsewhere');
        await hydrateSession(state, context);
        response.resolve({ kind: 'authenticated', tokens: tokens('a') });

        await expect(login).resolves.toStrictEqual({ kind: 'superseded' });
        expect(tokensOf(state)).toStrictEqual(tokens('elsewhere'));
        expect(api.calls).toStrictEqual(['login']);
    });

    it('discards the persisted session when a transition overtook the read', async () => {
        const { state, persistence, context } = fixture(tokens('a'));
        const gate = deferred<undefined>();
        persistence.loadGate = gate.promise;

        const hydrate = hydrateSession(state, context);

        await clearSession(state, context);
        persistence.snapshot = tokens('stale');
        gate.resolve(undefined);
        await hydrate;

        expect(state).toStrictEqual(createInitialSessionState());
    });

    it('propagates a persistence failure', async () => {
        const { state, persistence, context } = fixture();
        persistence.loadFailure = new Error('unavailable');

        await expect(hydrateSession(state, context)).rejects.toThrow('unavailable');
    });
});

describe('loginWithCredentials', () => {
    it('signs in, loads the user, then persists the session', async () => {
        const { state, api, persistence, context } = fixture();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(ALICE);

        await expect(loginWithCredentials(state, context, CREDENTIALS)).resolves.toStrictEqual({
            kind: 'authenticated',
        });

        expect(api.loginCalls).toStrictEqual([{ credentials: CREDENTIALS, device: DEVICE }]);
        expect(api.calls).toStrictEqual(['login', 'currentUser']);
        expect(persistence.operations).toStrictEqual(['save:access-a']);
        expect(persistence.snapshot).toStrictEqual(tokens('a'));
        expect(state).toStrictEqual({ ...tokens('a'), user: ALICE });
    });

    it('holds the tokens in state while the user loads, without the previous user', async () => {
        const { state, api, persistence, context } = fixture(tokens('old'));
        const user = deferred<SessionUser>();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(user.promise);

        const login = loginWithCredentials(state, context, CREDENTIALS);

        await flush();

        expect(state).toStrictEqual({ ...tokens('a'), user: null });
        expect(persistence.snapshot).toStrictEqual(tokens('old'));

        user.resolve(BOB);
        await login;

        expect(state.user).toStrictEqual(BOB);
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
        const pending = { credential: 'pending', requires: ['mfa'] };
        api.logins.push({ kind: 'interactionRequired', pending });

        await expect(loginWithCredentials(state, context, CREDENTIALS)).resolves.toStrictEqual({
            kind: 'interactionRequired',
            pending,
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

    it('rolls the session back when the user cannot be loaded', async () => {
        const { state, api, persistence, context } = fixture(tokens('old'));
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(new NetworkError('offline'));

        await expect(loginWithCredentials(state, context, CREDENTIALS)).rejects.toThrow('offline');

        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['clear']);
        expect(persistence.snapshot).toBeNull();
    });

    it('rolls the session back when it cannot be persisted', async () => {
        const { state, api, persistence, context } = fixture();
        api.logins.push({ kind: 'authenticated', tokens: tokens('a') });
        api.users.push(ALICE);
        persistence.saveFailure = new Error('quota');

        await expect(loginWithCredentials(state, context, CREDENTIALS)).rejects.toThrow('quota');

        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['save:access-a', 'clear']);
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
        expect(persistence.operations).toStrictEqual(['clear']);
    });

    it('is superseded by a sign-out while the user loads, persisting nothing', async () => {
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
        expect(persistence.operations).toStrictEqual(['clear']);
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
        expect(persistence.operations).toStrictEqual(['save:access-a', 'clear']);
        expect(persistence.snapshot).toBeNull();
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
        expect(persistence.snapshot).toStrictEqual(tokens('b'));
        expect(persistence.operations).toStrictEqual(['save:access-b']);
    });
});

describe('refreshSession', () => {
    it('presents the refresh token, persists the new pair, then applies it', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveGate = gate.promise;

        const refresh = refreshSession(state, context);

        await flush();

        expect(tokensOf(state)).toStrictEqual(tokens('a'));

        gate.resolve(undefined);

        await expect(refresh).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(api.refreshCalls).toStrictEqual(['refresh-a']);
        expect(persistence.snapshot).toStrictEqual(tokens('b'));
        expect(state).toStrictEqual({ ...tokens('b'), user: ALICE });
    });

    it('refreshes without a held refresh token, as with a cookie transport', async () => {
        const { state, api, context } = fixture(tokens('a', { refreshToken: null }));
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b', { refreshToken: null }) });

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(api.refreshCalls).toStrictEqual([null]);
        expect(state.accessToken).toBe('access-b');
    });

    it('keeps the new pair in memory and reports a failure when it cannot be persisted', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        const failure = new Error('quota');
        api.refreshes.push({ kind: 'refreshed', tokens: tokens('b') });
        persistence.saveFailure = failure;

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'failed', error: failure });
        expect(tokensOf(state)).toStrictEqual(tokens('b'));
        expect(persistence.snapshot).toStrictEqual(tokens('a'));
    });

    it.each(['retryable', 'failed'] as const)('keeps the tokens on a %s failure', async (kind) => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        const error = new HttpError(500, 'Server');
        api.refreshes.push({ kind, error });

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind, error });
        expect(state).toStrictEqual({ ...tokens('a'), user: ALICE });
        expect(persistence.operations).toStrictEqual([]);
    });

    it('keeps the tokens and hands back a pending session', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        const pending = { credential: 'pending', requires: ['mfa'] };
        api.refreshes.push({ kind: 'interactionRequired', pending });

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'interactionRequired', pending });
        expect(tokensOf(state)).toStrictEqual(tokens('a'));
        expect(persistence.operations).toStrictEqual([]);
    });

    it('classifies a failure the gateway throws, keeping the tokens when transient', async () => {
        const { state, api, context } = fixture(tokens('a'));
        const error = new NetworkError('offline');
        api.refreshes.push(error);

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'retryable', error });
        expect(tokensOf(state)).toStrictEqual(tokens('a'));
    });

    it('classifies a thrown 401 as a rejection, clearing the session', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        const error = new HttpError(401, 'Unauthorized');
        api.refreshes.push(error);

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'rejected', error });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.snapshot).toBeNull();
    });

    it('clears the session when persistence still holds the rejected session', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        const error = new HttpError(401, 'Unauthorized');
        api.refreshes.push({ kind: 'rejected', error });

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'rejected', error });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['load', 'clear']);
        expect(persistence.snapshot).toBeNull();
    });

    it('clears the session when nothing is persisted', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        persistence.snapshot = null;
        api.refreshes.push({ kind: 'rejected', error: null });

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'rejected', error: null });
        expect(state).toStrictEqual(createInitialSessionState());
    });

    it('clears the session when persistence cannot be read', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        persistence.snapshot = tokens('b');
        persistence.loadFailure = new Error('unavailable');
        api.refreshes.push({ kind: 'rejected', error: null });

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'rejected', error: null });
        expect(state).toStrictEqual(createInitialSessionState());
    });

    it('still reports the rejection when persistence cannot be cleared', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        persistence.clearFailure = new Error('unavailable');
        api.refreshes.push({ kind: 'rejected', error: null });

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'rejected', error: null });
        expect(state).toStrictEqual(createInitialSessionState());
    });

    it('adopts a session another context rotated in instead of clearing', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        persistence.snapshot = tokens('b');
        api.refreshes.push({ kind: 'rejected', error: null });

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(state).toStrictEqual({ ...tokens('b'), user: ALICE });
        expect(persistence.operations).toStrictEqual(['load']);
    });

    it('adopts a session whose refresh token alone differs', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        persistence.snapshot = tokens('a', { refreshToken: 'refresh-b' });
        api.refreshes.push({ kind: 'rejected', error: null });

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(state.refreshToken).toBe('refresh-b');
    });

    it('adopts a session whose access token alone differs, as with a cookie transport', async () => {
        const { state, api, persistence, context } = fixture(tokens('a', { refreshToken: null }));
        persistence.snapshot = tokens('b', { refreshToken: null });
        api.refreshes.push({ kind: 'rejected', error: null });

        await expect(refreshSession(state, context)).resolves.toStrictEqual({ kind: 'refreshed' });
        expect(state.accessToken).toBe('access-b');
    });

    it('is superseded by a sign-out during the refresh request, never re-applying tokens', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        const response = deferred<RefreshResult>();
        api.refreshes.push(response.promise);

        const refresh = refreshSession(state, context);

        await logoutSession(state, context);
        response.resolve({ kind: 'refreshed', tokens: tokens('b') });

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['clear']);
        expect(persistence.snapshot).toBeNull();
    });

    it('is superseded by a sign-out while the new pair persists', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
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
        expect(persistence.operations).toStrictEqual(['save:access-b', 'clear']);
        expect(persistence.snapshot).toBeNull();
    });

    it('is superseded by a sign-out while a failed persist settles', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
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
    });

    it('is superseded by a sign-out while the rejected session is compared', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        const gate = deferred<undefined>();
        api.refreshes.push({ kind: 'rejected', error: null });
        persistence.loadGate = gate.promise;
        persistence.snapshot = tokens('b');

        const refresh = refreshSession(state, context);

        await flush();
        await logoutSession(state, context);
        gate.resolve(undefined);

        await expect(refresh).resolves.toStrictEqual({ kind: 'superseded' });
        expect(state).toStrictEqual(createInitialSessionState());
    });
});

describe('logoutSession', () => {
    it('signs out server-side with the refresh token, then clears the session', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));

        await logoutSession(state, context);

        expect(api.logoutCalls).toStrictEqual(['refresh-a']);
        expect(state).toStrictEqual(createInitialSessionState());
        expect(persistence.operations).toStrictEqual(['clear']);
        expect(persistence.snapshot).toBeNull();
    });

    it('clears the session even when the server cannot be reached', async () => {
        const { state, api, context } = fixture(tokens('a'));
        api.logouts.push(new NetworkError('offline'));

        await logoutSession(state, context);

        expect(state).toStrictEqual(createInitialSessionState());
    });

    it('leaves a sign-in that started during the server call in place', async () => {
        const { state, api, persistence, context } = fixture(tokens('a'));
        const response = deferred<undefined>();
        api.logouts.push(response.promise);

        const logout = logoutSession(state, context);

        api.logins.push({ kind: 'authenticated', tokens: tokens('b') });
        api.users.push(BOB);
        await loginWithCredentials(state, context, CREDENTIALS);
        response.resolve(undefined);
        await logout;

        expect(state).toStrictEqual({ ...tokens('b'), user: BOB });
        expect(persistence.snapshot).toStrictEqual(tokens('b'));
    });

    it('propagates a persistence failure after clearing the state', async () => {
        const { state, persistence, context } = fixture(tokens('a'));
        persistence.clearFailure = new Error('unavailable');

        await expect(logoutSession(state, context)).rejects.toThrow('unavailable');
        expect(state).toStrictEqual(createInitialSessionState());
    });
});

describe('clearSession', () => {
    it('clears the state before persistence settles', async () => {
        const { state, persistence, context } = fixture(tokens('a'));

        const clear = clearSession(state, context);

        expect(state).toStrictEqual(createInitialSessionState());

        await clear;

        expect(persistence.snapshot).toBeNull();
    });

    it('propagates a persistence failure', async () => {
        const { state, persistence, context } = fixture(tokens('a'));
        persistence.clearFailure = new Error('unavailable');

        await expect(clearSession(state, context)).rejects.toThrow('unavailable');
    });
});

describe('rehydrateSessionUser', () => {
    it('does nothing when signed out', async () => {
        const { state, api, context } = fixture();

        await rehydrateSessionUser(state, context);

        expect(api.calls).toStrictEqual([]);
    });

    it('does nothing when the user is already loaded', async () => {
        const { state, api, context } = fixture(tokens('a'));

        await rehydrateSessionUser(state, context);

        expect(api.calls).toStrictEqual([]);
    });

    it('loads the user', async () => {
        const { state, api, context } = fixture(tokens('a'));
        state.user = null;
        api.users.push(BOB);

        await rehydrateSessionUser(state, context);

        expect(state.user).toStrictEqual(BOB);
    });

    it('shares one request between concurrent callers, then allows another', async () => {
        const { state, api, context } = fixture(tokens('a'));
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
        const { state, api, context } = fixture(tokens('a'));
        const user = deferred<SessionUser>();
        state.user = null;
        api.users.push(user.promise);

        const rehydrate = rehydrateSessionUser(state, context);

        await clearSession(state, context);
        user.resolve(ALICE);
        await rehydrate;

        expect(state.user).toBeNull();
    });
});
