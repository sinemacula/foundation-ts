/**
 * Unit tests for the session core transitions.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { MemoryStorage } from '../storage/memory-storage';
import type { SessionApi, SessionDevice } from './session-api';
import type { SessionCoreContext } from './session-core';
import {
    clearSession,
    createInitialSessionState,
    hydrateStateFromStorage,
    loginWithCredentials,
    logoutSession,
    refreshSession,
    rehydrateSessionUser,
} from './session-core';
import type { SessionState } from './session-state';
import type { SessionTokens } from './session-tokens';
import type { SessionUser } from './session-user';

const ACCESS_TOKEN_KEY = 'auth.access_token';
const REFRESH_TOKEN_KEY = 'auth.refresh_token';
const EXPIRES_AT_KEY = 'auth.expires_at';

/**
 * The epoch-millisecond instant for the UTC wire timestamp 2026-12-31 23:59:59.
 */
const SESSION_EXPIRY_EPOCH_MS = 1_798_761_599_000;

/**
 * An in-memory {@link SessionApi} fake that records every call and replays
 * queued outcomes in order.
 */
class FakeSessionApi implements SessionApi {
    readonly calls: string[] = [];
    readonly loginCalls: Array<{ credentials: unknown; device: SessionDevice }> = [];
    readonly refreshCalls: string[] = [];

    readonly #sessions: Array<SessionTokens | Error> = [];
    readonly #users: Array<SessionUser | Error> = [];
    #logoutError: Error | null = null;

    /**
     * Queue an outcome for the next login or refresh call.
     *
     * @param outcome - the tokens to resolve with, or the error to reject with
     */
    queueSession(outcome: SessionTokens | Error): void {
        this.#sessions.push(outcome);
    }

    /**
     * Queue an outcome for the next currentUser call.
     *
     * @param outcome - the user to resolve with, or the error to reject with
     */
    queueUser(outcome: SessionUser | Error): void {
        this.#users.push(outcome);
    }

    /**
     * Make the next logout call reject.
     *
     * @param error - the error to reject with
     */
    failLogout(error: Error): void {
        this.#logoutError = error;
    }

    login(credentials: unknown, device: SessionDevice): Promise<SessionTokens> {
        this.calls.push('login');
        this.loginCalls.push({ credentials, device });

        return take(this.#sessions);
    }

    refresh(refreshToken: string): Promise<SessionTokens> {
        this.calls.push('refresh');
        this.refreshCalls.push(refreshToken);

        return take(this.#sessions);
    }

    logout(): Promise<void> {
        this.calls.push('logout');

        return this.#logoutError === null ? Promise.resolve() : Promise.reject(this.#logoutError);
    }

    currentUser(): Promise<SessionUser> {
        this.calls.push('currentUser');

        return take(this.#users);
    }
}

/**
 * Consume the next queued outcome.
 *
 * @param queue - the outcome queue
 * @returns a promise resolving or rejecting with the next outcome
 */
function take<T>(queue: Array<T | Error>): Promise<T> {
    const outcome = queue.shift();

    if (outcome === undefined) {
        return Promise.reject(new Error('No queued outcome.'));
    }

    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
}

/** A valid token bundle as returned by the gateway. */
function tokens(overrides: Partial<SessionTokens> = {}): SessionTokens {
    return {
        accessToken: 'new-token',
        refreshToken: 'new-refresh-token',
        expiresAtEpochMs: SESSION_EXPIRY_EPOCH_MS,
        ...overrides,
    };
}

/** A mapped user record as returned by the gateway. */
function user(): SessionUser {
    return { id: 'u1', email: 'alice@example.com', name: 'Alice Smith', permissions: [] };
}

describe('session core', () => {
    let storage: MemoryStorage;
    let fake: FakeSessionApi;
    let parseCalls: string[];

    /**
     * Build a core context over the test collaborators.
     *
     * @param overrides - optional context overrides
     * @returns the assembled context
     */
    function context(overrides: { parseTimestamp?: (value: string) => number | null } = {}): SessionCoreContext {
        return {
            storage,
            storageKeys: {
                accessToken: ACCESS_TOKEN_KEY,
                refreshToken: REFRESH_TOKEN_KEY,
                expiresAt: EXPIRES_AT_KEY,
                deviceUuid: 'auth.device_uuid',
            },
            api: fake,
            device: () => ({ uuid: 'device-uuid-1', os: 'WEB' }),
            parseTimestamp:
                overrides.parseTimestamp ??
                ((value: string): null => {
                    parseCalls.push(value);

                    return null;
                }),
        };
    }

    /** A signed-out state with nothing persisted. */
    function emptyState(): SessionState {
        return { accessToken: null, refreshToken: null, expiresAtEpochMs: null, user: null };
    }

    beforeEach(() => {
        storage = new MemoryStorage();
        fake = new FakeSessionApi();
        parseCalls = [];
    });

    describe('createInitialSessionState', () => {
        it('reads the persisted tokens from storage', () => {
            storage.set(ACCESS_TOKEN_KEY, 'persisted-token');
            storage.set(REFRESH_TOKEN_KEY, 'persisted-refresh');

            const state = createInitialSessionState(context());

            expect(state.accessToken).toBe('persisted-token');
            expect(state.refreshToken).toBe('persisted-refresh');
        });

        it('initialises every field as null when storage is empty', () => {
            expect(createInitialSessionState(context())).toStrictEqual(emptyState());
            expect(parseCalls).toStrictEqual([]);
        });

        it('hydrates a digits-only persisted expiry as epoch milliseconds', () => {
            storage.set(EXPIRES_AT_KEY, '1782820800000');

            expect(createInitialSessionState(context()).expiresAtEpochMs).toBe(1_782_820_800_000);
            expect(parseCalls).toStrictEqual([]);
        });

        it('delegates a legacy non-numeric expiry to the configured parser', () => {
            storage.set(EXPIRES_AT_KEY, '2026-06-30 12:00:00');

            const state = createInitialSessionState(
                context({ parseTimestamp: value => (value === '2026-06-30 12:00:00' ? 1_782_820_800_000 : null) }),
            );

            expect(state.expiresAtEpochMs).toBe(1_782_820_800_000);
        });

        it('hydrates expiry as null when the legacy value is unparseable', () => {
            storage.set(EXPIRES_AT_KEY, 'not-a-timestamp');

            expect(createInitialSessionState(context()).expiresAtEpochMs).toBeNull();
            expect(parseCalls).toStrictEqual(['not-a-timestamp']);
        });
    });

    describe('loginWithCredentials', () => {
        it('sets the tokens and user after a successful login', async () => {
            fake.queueSession(tokens());
            fake.queueUser(user());

            const state = emptyState();

            await loginWithCredentials(state, context(), { email: 'alice@example.com', password: 'secret' });

            expect(state.accessToken).toBe('new-token');
            expect(state.refreshToken).toBe('new-refresh-token');
            expect(state.expiresAtEpochMs).toBe(SESSION_EXPIRY_EPOCH_MS);
            expect(state.user).toStrictEqual(user());
        });

        it('forwards the credentials and device fingerprint to the gateway', async () => {
            fake.queueSession(tokens());
            fake.queueUser(user());

            await loginWithCredentials(emptyState(), context(), { email: 'alice@example.com', password: 'secret' });

            expect(fake.loginCalls).toStrictEqual([
                {
                    credentials: { email: 'alice@example.com', password: 'secret' },
                    device: { uuid: 'device-uuid-1', os: 'WEB' },
                },
            ]);
        });

        it('persists every session key, with expiry as an epoch-ms string', async () => {
            fake.queueSession(tokens({ accessToken: 'stored-token', refreshToken: 'stored-refresh' }));
            fake.queueUser(user());

            await loginWithCredentials(emptyState(), context(), { email: 'alice@example.com', password: 'secret' });

            expect(storage.get(ACCESS_TOKEN_KEY)).toBe('stored-token');
            expect(storage.get(REFRESH_TOKEN_KEY)).toBe('stored-refresh');
            expect(storage.get(EXPIRES_AT_KEY)).toBe('1798761599000');
        });

        it('fetches the current user after the session is applied', async () => {
            fake.queueSession(tokens());
            fake.queueUser(user());

            const state = emptyState();

            await loginWithCredentials(state, context(), { email: 'alice@example.com', password: 'secret' });

            expect(fake.calls).toStrictEqual(['login', 'currentUser']);
            expect(state.user?.name).toBe('Alice Smith');
        });

        it('removes the persisted expiry when the session has none', async () => {
            storage.set(EXPIRES_AT_KEY, '1782820800000');
            fake.queueSession(tokens({ expiresAtEpochMs: null }));
            fake.queueUser(user());

            const state = emptyState();

            await loginWithCredentials(state, context(), { email: 'alice@example.com', password: 'secret' });

            expect(state.expiresAtEpochMs).toBeNull();
            expect(storage.get(EXPIRES_AT_KEY)).toBeNull();
        });

        it('removes rather than writes the absent refresh token and expiry keys', async () => {
            fake.queueSession(tokens({ refreshToken: null, expiresAtEpochMs: null }));
            fake.queueUser(user());

            const removed: string[] = [];
            const written: string[] = [];
            const base = context();
            const recording = {
                ...base,
                storage: {
                    get: (key: string) => storage.get(key),
                    set: (key: string, value: string) => {
                        written.push(key);
                        storage.set(key, value);
                    },
                    remove: (key: string) => {
                        removed.push(key);
                        storage.remove(key);
                    },
                },
            };

            await loginWithCredentials(emptyState(), recording, { email: 'alice@example.com', password: 'secret' });

            expect(removed).toStrictEqual([REFRESH_TOKEN_KEY, EXPIRES_AT_KEY]);
            expect(written).toStrictEqual([ACCESS_TOKEN_KEY]);
        });

        it('removes the persisted refresh token when the session has none', async () => {
            storage.set(REFRESH_TOKEN_KEY, 'old-refresh');
            fake.queueSession(tokens({ refreshToken: null }));
            fake.queueUser(user());

            const state = emptyState();

            await loginWithCredentials(state, context(), { email: 'alice@example.com', password: 'secret' });

            expect(state.refreshToken).toBeNull();
            expect(storage.get(REFRESH_TOKEN_KEY)).toBeNull();
        });
    });

    describe('refreshSession', () => {
        it('returns false immediately when no refresh token is in state', async () => {
            const result = await refreshSession(emptyState(), context());

            expect(result).toBe(false);
            expect(fake.calls).toStrictEqual([]);
        });

        it('updates tokens and returns true on a successful refresh', async () => {
            fake.queueSession(tokens({ accessToken: 'fresh-token', refreshToken: 'fresh-refresh' }));

            const state = { ...emptyState(), refreshToken: 'old-refresh' };
            const result = await refreshSession(state, context());

            expect(result).toBe(true);
            expect(fake.refreshCalls).toStrictEqual(['old-refresh']);
            expect(state.accessToken).toBe('fresh-token');
            expect(state.refreshToken).toBe('fresh-refresh');
            expect(state.expiresAtEpochMs).toBe(SESSION_EXPIRY_EPOCH_MS);
            expect(storage.get(ACCESS_TOKEN_KEY)).toBe('fresh-token');
            expect(storage.get(REFRESH_TOKEN_KEY)).toBe('fresh-refresh');
            expect(storage.get(EXPIRES_AT_KEY)).toBe('1798761599000');
        });

        it('clears the session and returns false when the refresh request fails', async () => {
            storage.set(ACCESS_TOKEN_KEY, 'old-token');
            storage.set(REFRESH_TOKEN_KEY, 'old-refresh');
            storage.set(EXPIRES_AT_KEY, '1782820800000');
            fake.queueSession(new Error('401 Unauthorized'));

            const state: SessionState = {
                accessToken: 'old-token',
                refreshToken: 'old-refresh',
                expiresAtEpochMs: 1_782_820_800_000,
                user: user(),
            };
            const result = await refreshSession(state, context());

            expect(result).toBe(false);
            expect(state).toStrictEqual(emptyState());
            expect(storage.get(ACCESS_TOKEN_KEY)).toBeNull();
            expect(storage.get(REFRESH_TOKEN_KEY)).toBeNull();
            expect(storage.get(EXPIRES_AT_KEY)).toBeNull();
        });
    });

    describe('logoutSession', () => {
        it('calls the logout endpoint and clears the session state and storage', async () => {
            storage.set(ACCESS_TOKEN_KEY, 'tok');

            const state: SessionState = { ...emptyState(), accessToken: 'tok', user: user() };

            await logoutSession(state, context());

            expect(fake.calls).toStrictEqual(['logout']);
            expect(state).toStrictEqual(emptyState());
            expect(storage.get(ACCESS_TOKEN_KEY)).toBeNull();
        });

        it('still clears local state when the logout API call rejects', async () => {
            storage.set(ACCESS_TOKEN_KEY, 'tok');
            fake.failLogout(new Error('network failure'));

            const state: SessionState = { ...emptyState(), accessToken: 'tok', user: user() };

            await logoutSession(state, context());

            expect(state).toStrictEqual(emptyState());
            expect(storage.get(ACCESS_TOKEN_KEY)).toBeNull();
        });
    });

    describe('hydrateStateFromStorage', () => {
        it('re-reads all three persisted keys into state', () => {
            storage.set(ACCESS_TOKEN_KEY, 'other-tab-token');
            storage.set(REFRESH_TOKEN_KEY, 'other-tab-refresh');
            storage.set(EXPIRES_AT_KEY, '1786752000000');

            const state = emptyState();

            hydrateStateFromStorage(state, context());

            expect(state.accessToken).toBe('other-tab-token');
            expect(state.refreshToken).toBe('other-tab-refresh');
            expect(state.expiresAtEpochMs).toBe(1_786_752_000_000);
        });

        it('delegates a legacy expiry to the configured parser on hydration', () => {
            storage.set(EXPIRES_AT_KEY, '2026-06-30 12:00:00');

            const state = emptyState();

            hydrateStateFromStorage(state, context({ parseTimestamp: () => 1_782_820_800_000 }));

            expect(state.expiresAtEpochMs).toBe(1_782_820_800_000);
        });

        it('resets state to null when storage has no persisted keys', () => {
            const state = { ...emptyState(), accessToken: 'stale-token' };

            hydrateStateFromStorage(state, context());

            expect(state.accessToken).toBeNull();
        });

        it('does not call the API', () => {
            hydrateStateFromStorage(emptyState(), context());

            expect(fake.calls).toStrictEqual([]);
        });
    });

    describe('clearSession', () => {
        it('clears the state and removes every persisted key without calling the API', () => {
            storage.set(ACCESS_TOKEN_KEY, 'tok');
            storage.set(REFRESH_TOKEN_KEY, 'refresh');
            storage.set(EXPIRES_AT_KEY, '1782820800000');

            const state: SessionState = {
                accessToken: 'tok',
                refreshToken: 'refresh',
                expiresAtEpochMs: 1_782_820_800_000,
                user: user(),
            };

            clearSession(state, context());

            expect(fake.calls).toStrictEqual([]);
            expect(state).toStrictEqual(emptyState());
            expect(storage.get(ACCESS_TOKEN_KEY)).toBeNull();
            expect(storage.get(REFRESH_TOKEN_KEY)).toBeNull();
            expect(storage.get(EXPIRES_AT_KEY)).toBeNull();
        });
    });

    describe('rehydrateSessionUser', () => {
        it('fetches and stores the current user when a token is present but no user is loaded', async () => {
            fake.queueUser(user());

            const state = { ...emptyState(), accessToken: 'tok' };

            await rehydrateSessionUser(state, context());

            expect(state.user?.email).toBe('alice@example.com');
        });

        it('does nothing when no access token is present', async () => {
            const state = emptyState();

            await rehydrateSessionUser(state, context());

            expect(state.user).toBeNull();
            expect(fake.calls).toStrictEqual([]);
        });

        it('does nothing when a user is already loaded', async () => {
            fake.queueUser(user());

            const state = { ...emptyState(), accessToken: 'tok' };

            await rehydrateSessionUser(state, context());
            await rehydrateSessionUser(state, context());

            expect(fake.calls).toStrictEqual(['currentUser']);
        });

        it('swallows failures and leaves the user unset', async () => {
            fake.queueUser(new Error('network failure'));

            const state = { ...emptyState(), accessToken: 'tok' };

            await expect(rehydrateSessionUser(state, context())).resolves.toBeUndefined();
            expect(state.user).toBeNull();
        });

        it('retries the fetch on a later call after a swallowed failure', async () => {
            fake.queueUser(new Error('network failure'));
            fake.queueUser(user());

            const state = { ...emptyState(), accessToken: 'tok' };

            await rehydrateSessionUser(state, context());
            await rehydrateSessionUser(state, context());

            expect(fake.calls).toStrictEqual(['currentUser', 'currentUser']);
            expect(state.user?.email).toBe('alice@example.com');
        });

        it('shares one request across concurrent rehydrations of the same state', async () => {
            fake.queueUser(user());

            const state = { ...emptyState(), accessToken: 'tok' };

            await Promise.all([rehydrateSessionUser(state, context()), rehydrateSessionUser(state, context())]);

            expect(fake.calls).toStrictEqual(['currentUser']);
            expect(state.user?.email).toBe('alice@example.com');
        });
    });
});
