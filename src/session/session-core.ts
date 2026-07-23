/**
 * Session core transitions.
 *
 * The platform-agnostic session lifecycle: every transition operates on an
 * explicit mutable {@link SessionState} plus the route-free context slice, so
 * each platform's store stays a thin delegator that forwards its own state and
 * installed context. All token writes to storage happen here; state hydrates
 * synchronously from storage, and expiry persists as an epoch-millisecond
 * string - legacy wire-format values from sessions predating that format are
 * delegated to the context's timestamp parser.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { KeyValueStorage } from '../storage/key-value-storage';
import type { SessionApi, SessionDevice } from './session-api';
import type { SessionState } from './session-state';
import type { SessionStorageKeys } from './session-storage-keys';
import type { SessionTokens } from './session-tokens';
import type { SessionUser } from './session-user';

/**
 * The route-free context slice the session-core transitions consume.
 */
export interface SessionCoreContext<U extends SessionUser = SessionUser> {
    /** The storage adapter session state persists to. */
    readonly storage: KeyValueStorage;

    /** The resolved storage keys the session persists under. */
    readonly storageKeys: SessionStorageKeys;

    /** The session API gateway. */
    readonly api: SessionApi<U>;

    /** Resolve the stable device fingerprint. */
    readonly device: () => SessionDevice;

    /** Convert a legacy persisted wire timestamp to epoch milliseconds during hydration; returns null for unparseable values. */
    readonly parseTimestamp: (value: string) => number | null;
}

/**
 * Build the initial session state by synchronously reading the persisted
 * session out of storage.
 *
 * @param context - the session core context
 * @returns the hydrated initial state, with no user loaded
 */
export function createInitialSessionState(context: SessionCoreContext): SessionState {
    return {
        accessToken: context.storage.get(context.storageKeys.accessToken),
        refreshToken: context.storage.get(context.storageKeys.refreshToken),
        expiresAtEpochMs: readPersistedExpiry(context),
        user: null,
    };
}

/**
 * Exchange credentials for a session, persist it, and load the current user.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 * @param credentials - the login credentials
 */
export async function loginWithCredentials(
    state: SessionState,
    context: SessionCoreContext,
    credentials: unknown,
): Promise<void> {
    // The credential shape is the gateway's concern; the core forwards it
    // opaquely.
    const session = await context.api.login(
        credentials as {
            /** The submitted account email address. */
            email: string;

            /** The submitted account password. */
            password: string;
        },
        context.device(),
    );

    applySession(state, context, session);

    state.user = await context.api.currentUser();
}

/**
 * Use the refresh token to obtain a new session.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 * @returns true when the session was refreshed; false (with the session
 * cleared) when no refresh token exists or the request fails
 */
export async function refreshSession(state: SessionState, context: SessionCoreContext): Promise<boolean> {
    if (state.refreshToken === null) {
        return false;
    }

    try {
        applySession(state, context, await context.api.refresh(state.refreshToken));

        return true;
    } catch {
        clearSession(state, context);

        return false;
    }
}

/**
 * Discard the session locally and best-effort invalidate it server-side.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 */
export async function logoutSession(state: SessionState, context: SessionCoreContext): Promise<void> {
    try {
        await context.api.logout();
    } catch {
        // The local session is discarded regardless of server reachability.
    }

    clearSession(state, context);
}

/**
 * Re-read the persisted tokens and expiry from storage into state.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 */
export function hydrateStateFromStorage(state: SessionState, context: SessionCoreContext): void {
    state.accessToken = context.storage.get(context.storageKeys.accessToken);
    state.refreshToken = context.storage.get(context.storageKeys.refreshToken);
    state.expiresAtEpochMs = readPersistedExpiry(context);
}

/**
 * Concurrent user rehydrations, keyed by store state, so the boot-time load and
 * a route guard awaiting it share one request rather than double-fetching.
 */
const inFlightRehydration = new WeakMap<SessionState, Promise<void>>();

/**
 * Fetch and store the current user when a session is present but no user record
 * has been loaded yet. Concurrent callers share the single in-flight request,
 * and failures are swallowed.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 */
export async function rehydrateSessionUser(state: SessionState, context: SessionCoreContext): Promise<void> {
    if (state.accessToken === null || state.user !== null) {
        return;
    }

    const existing = inFlightRehydration.get(state);

    if (existing !== undefined) {
        return existing;
    }

    const load = fetchCurrentUser(state, context);

    inFlightRehydration.set(state, load);

    try {
        await load;
    } finally {
        inFlightRehydration.delete(state);
    }
}

/**
 * Fetch the current user into state, swallowing a dead-session failure.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 */
async function fetchCurrentUser(state: SessionState, context: SessionCoreContext): Promise<void> {
    try {
        state.user = await context.api.currentUser();
    } catch {
        // Swallowed: a dead session is handled by the 401-refresh flow or the
        // session-loss watcher.
    }
}

/**
 * Apply a freshly issued session onto the state and persist it to storage.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 * @param session - the session returned by login or refresh
 */
function applySession(state: SessionState, context: SessionCoreContext, session: SessionTokens): void {
    state.accessToken = session.accessToken;
    state.refreshToken = session.refreshToken;
    state.expiresAtEpochMs = session.expiresAtEpochMs;

    context.storage.set(context.storageKeys.accessToken, session.accessToken);

    if (session.refreshToken === null) {
        context.storage.remove(context.storageKeys.refreshToken);
    } else {
        context.storage.set(context.storageKeys.refreshToken, session.refreshToken);
    }

    if (session.expiresAtEpochMs === null) {
        context.storage.remove(context.storageKeys.expiresAt);
    } else {
        context.storage.set(context.storageKeys.expiresAt, String(session.expiresAtEpochMs));
    }
}

/**
 * Clear all session state and remove every persisted session key from storage.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 */
export function clearSession(state: SessionState, context: SessionCoreContext): void {
    state.accessToken = null;
    state.refreshToken = null;
    state.expiresAtEpochMs = null;
    state.user = null;

    context.storage.remove(context.storageKeys.accessToken);
    context.storage.remove(context.storageKeys.refreshToken);
    context.storage.remove(context.storageKeys.expiresAt);
}

/**
 * Read the persisted expiry, tolerating the legacy wire format.
 *
 * @param context - the session core context
 * @returns the expiry in epoch milliseconds, or null when absent or unparseable
 */
function readPersistedExpiry(context: SessionCoreContext): number | null {
    const persisted = context.storage.get(context.storageKeys.expiresAt);

    if (persisted === null) {
        return null;
    }

    // Digits-only values are the current epoch-ms format; anything else is a
    // legacy wire timestamp.
    return /^\d+$/.test(persisted) ? Number(persisted) : context.parseTimestamp(persisted);
}
