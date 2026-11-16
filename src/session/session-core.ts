/**
 * Session core transitions.
 *
 * The platform-agnostic session lifecycle: every transition operates on an
 * explicit mutable {@link SessionState} plus the route-free context slice, so
 * each platform's store stays a thin delegator that forwards its own state and
 * installed context. All token writes to persistence happen here, and each is
 * awaited before a transition reports success.
 *
 * Every transition that replaces or discards the session advances a per-state
 * epoch; an asynchronous step that resumes under a newer epoch discards its
 * result, so a sign-out during an in-flight refresh or user fetch can never be
 * undone by it. Persistence writes are serialised per state, so a clear never
 * lands before a save issued ahead of it.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { PasswordCredentials, SessionApi, SessionDevice } from './session-api';
import type { LoginOutcome, RefreshOutcome, RefreshResult } from './session-outcomes';
import { classifyRefreshError } from './session-outcomes';
import type { SessionPersistence } from './session-persistence';
import type { SessionState } from './session-state';
import type { SessionTokens } from './session-tokens';
import type { SessionUser } from './session-user';

/**
 * The route-free context slice the session-core transitions consume.
 */
export interface SessionCoreContext<U extends SessionUser = SessionUser, C = PasswordCredentials> {
    /** The asynchronous store the session's token snapshot persists to. */
    readonly persistence: SessionPersistence;

    /** The session API gateway. */
    readonly api: SessionApi<U, C>;

    /** Resolve the stable device fingerprint. */
    readonly device: () => SessionDevice;
}

const SUPERSEDED = { kind: 'superseded' } as const;
const REFRESHED = { kind: 'refreshed' } as const;

/**
 * The session epoch of each state: a fresh token issued by every transition
 * that replaces or discards the session.
 */
const epochs = new WeakMap<object, object>();

/**
 * Concurrent user rehydrations, keyed by store state, so the boot-time load and
 * a route guard awaiting it share one request rather than double-fetching.
 */
const inFlightRehydration = new WeakMap<object, Promise<void>>();

/**
 * The tail of each state's persistence write chain.
 */
const writes = new WeakMap<object, Promise<unknown>>();

/**
 * Build an empty, signed-out session state. Platforms then await
 * {@link hydrateSession} before exposing authenticated state.
 *
 * @returns the initial state, holding no session
 */
export function createInitialSessionState<U extends SessionUser = SessionUser>(): SessionState<U> {
    return { accessToken: null, refreshToken: null, expiresAtEpochMs: null, user: null };
}

/**
 * Read the persisted session into state. Awaited at boot before authenticated
 * state is exposed, and again whenever another context changes the persisted
 * session. A persistence failure propagates.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 */
export async function hydrateSession<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
): Promise<void> {
    const epoch = epochOf(state);
    const snapshot = await context.persistence.load();

    if (epochOf(state) !== epoch) {
        return;
    }

    if (snapshot === null) {
        if (state.accessToken !== null) {
            resetState(state);
        }

        return;
    }

    // Arriving from signed out is a new session; a rotation is the same one.
    if (state.accessToken === null) {
        advanceEpoch(state);
    }

    setTokens(state, snapshot);
}

/**
 * Exchange credentials for a session, load the current user, and persist the
 * session. When loading the user or persisting fails, the session is rolled
 * back and the failure rethrown.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 * @param credentials - the login credentials
 * @returns what the sign-in did
 */
export async function loginWithCredentials<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
    credentials: C,
): Promise<LoginOutcome> {
    const started = epochOf(state);
    const result = await context.api.login(credentials, context.device());

    if (epochOf(state) !== started) {
        return SUPERSEDED;
    }

    if (result.kind === 'interactionRequired') {
        return result;
    }

    const epoch = advanceEpoch(state);

    setTokens(state, result.tokens);
    state.user = null;

    try {
        const user = await context.api.currentUser();

        if (epochOf(state) !== epoch) {
            return SUPERSEDED;
        }

        await persist(state, () => context.persistence.save(result.tokens));

        if (epochOf(state) !== epoch) {
            return SUPERSEDED;
        }

        state.user = user;
    } catch (error) {
        if (epochOf(state) === epoch) {
            await clearSession(state, context).catch(() => undefined);
        }

        throw error;
    }

    return { kind: 'authenticated' };
}

/**
 * Exchange the refresh credential for a new session.
 *
 * A refusal clears the session only when persistence still holds the session
 * that was refused; when another context has meanwhile persisted a newer
 * session, that session is adopted instead. Every other failure keeps the
 * tokens. The refresh credential may be absent from state, as when it travels
 * in a cookie; the gateway decides whether it can refresh without one.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 * @returns what the refresh did
 */
export async function refreshSession<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
): Promise<RefreshOutcome> {
    const epoch = epochOf(state);
    const presented = { accessToken: state.accessToken, refreshToken: state.refreshToken };
    const result = await requestRefresh(context, presented.refreshToken);

    if (epochOf(state) !== epoch) {
        return SUPERSEDED;
    }

    if (result.kind === 'refreshed') {
        const outcome: RefreshOutcome = await persist(state, () => context.persistence.save(result.tokens)).then(
            () => REFRESHED,
            (error: unknown) => ({ kind: 'failed', error }),
        );

        if (epochOf(state) !== epoch) {
            return SUPERSEDED;
        }

        // The server has rotated the pair, so it is kept in memory even when it
        // could not be persisted.
        setTokens(state, result.tokens);

        return outcome;
    }

    if (result.kind !== 'rejected') {
        return result;
    }

    const stored = await context.persistence.load().catch(() => null);

    if (epochOf(state) !== epoch) {
        return SUPERSEDED;
    }

    if (
        stored !== null &&
        (stored.accessToken !== presented.accessToken || stored.refreshToken !== presented.refreshToken)
    ) {
        setTokens(state, stored);

        return REFRESHED;
    }

    await clearSession(state, context).catch(() => undefined);

    return result;
}

/**
 * Discard the session locally and best-effort invalidate it server-side. A
 * sign-in started while the server call is in flight is left in place.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 */
export async function logoutSession<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
): Promise<void> {
    const epoch = advanceEpoch(state);

    try {
        await context.api.logout(state.refreshToken);
    } catch {
        // The local session is discarded regardless of server reachability.
    }

    if (epochOf(state) === epoch) {
        await clearSession(state, context);
    }
}

/**
 * Clear all session state, then remove the persisted session. State is cleared
 * before the returned promise settles; a persistence failure propagates.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 */
export async function clearSession<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
): Promise<void> {
    resetState(state);

    await persist(state, () => context.persistence.clear());
}

/**
 * Fetch and store the current user when a session is present but no user record
 * has been loaded yet. Concurrent callers share the single in-flight request,
 * and failures are swallowed.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 */
export async function rehydrateSessionUser<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
): Promise<void> {
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
 * Fetch the current user into state, swallowing a dead-session failure and
 * discarding a user that arrives after the session was replaced.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 */
async function fetchCurrentUser<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
): Promise<void> {
    const epoch = epochOf(state);

    try {
        const user = await context.api.currentUser();

        if (epochOf(state) === epoch) {
            state.user = user;
        }
    } catch {
        // Swallowed: a dead session is handled by the 401-refresh flow or the
        // session-loss watcher.
    }
}

/**
 * Ask the gateway for a refresh, classifying a thrown failure with the default
 * policy.
 *
 * @param context - the session core context
 * @param refreshToken - the refresh token to present, or null
 * @returns the gateway's refresh result
 */
async function requestRefresh<U extends SessionUser, C>(
    context: SessionCoreContext<U, C>,
    refreshToken: string | null,
): Promise<RefreshResult> {
    try {
        return await context.api.refresh(refreshToken);
    } catch (error) {
        return { kind: classifyRefreshError(error), error };
    }
}

/**
 * Run a persistence write once every write issued before it has settled.
 *
 * @param state - the session state whose writes are serialised
 * @param write - the write to run
 * @returns the write's result
 */
function persist(state: object, write: () => Promise<void>): Promise<void> {
    const next = (writes.get(state) ?? Promise.resolve()).then(write);

    writes.set(
        state,
        next.catch(() => undefined),
    );

    return next;
}

/**
 * Write a token set onto the state.
 *
 * @param state - the mutable session state
 * @param tokens - the tokens to apply
 */
function setTokens(state: SessionState<SessionUser>, tokens: SessionTokens): void {
    state.accessToken = tokens.accessToken;
    state.refreshToken = tokens.refreshToken;
    state.expiresAtEpochMs = tokens.expiresAtEpochMs;
}

/**
 * Discard the session from state and advance its epoch.
 *
 * @param state - the mutable session state
 */
function resetState(state: SessionState<SessionUser>): void {
    advanceEpoch(state);

    state.accessToken = null;
    state.refreshToken = null;
    state.expiresAtEpochMs = null;
    state.user = null;
}

/**
 * Read the state's current session epoch.
 *
 * @param state - the session state
 * @returns the epoch token, or undefined before the first transition
 */
function epochOf(state: object): object | undefined {
    return epochs.get(state);
}

/**
 * Advance the state's session epoch, invalidating every in-flight step.
 *
 * @param state - the session state
 * @returns the new epoch token
 */
function advanceEpoch(state: object): object {
    const next = {};

    epochs.set(state, next);

    return next;
}
