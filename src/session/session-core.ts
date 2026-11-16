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
 * undone by it. The persistence operations of one state run one at a time, and
 * each re-checks the epoch when it starts.
 *
 * Each state tracks the persisted revision it is based on. A snapshot at a
 * higher revision is another context's session and replaces the state's; a
 * snapshot at the same revision is never adopted, so a rotated pair that could
 * not be persisted is never traded back for the spent pair still stored.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { InProcessSessionLock } from './in-process-session-lock';
import type { PasswordCredentials, SessionApi, SessionDevice } from './session-api';
import type { LoginOutcome, RefreshOutcome, RefreshResult } from './session-outcomes';
import { classifyRefreshError } from './session-outcomes';
import type { SessionClearResult, SessionPersistence, SessionSaveResult, SessionSnapshot } from './session-persistence';
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

/**
 * The bookkeeping the transitions keep for one state.
 */
interface Ledger {
    /** A fresh token issued by every transition that replaces or discards the session. */
    epoch: object;

    /** The persisted revision the state is based on. */
    revision: number;

    /** The rotated pair the state holds that could not be persisted, or null. */
    unsaved: SessionTokens | null;

    /** Runs the state's persistence operations one at a time. */
    readonly operations: InProcessSessionLock;

    /** The in-flight user fetch and the epoch it serves, or null. */
    rehydration: Rehydration | null;
}

/**
 * A user fetch shared by the callers of one epoch.
 */
interface Rehydration {
    /** The epoch the fetch serves. */
    readonly epoch: object;

    /** Settles when the fetch has settled. */
    readonly promise: Promise<void>;
}

const AUTHENTICATED = { kind: 'authenticated' } as const;
const SUPERSEDED = { kind: 'superseded' } as const;
const REFRESHED = { kind: 'refreshed' } as const;

/**
 * The ledger of each state.
 */
const ledgers = new WeakMap<object, Ledger>();

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
 * Bring the state in line with the persisted session. Awaited at boot before
 * authenticated state is exposed, and again whenever another context changes
 * the persisted session.
 *
 * A session another context wrote replaces the state's and drops the user, so
 * the caller refetches it with {@link rehydrateSessionUser} once hydration has
 * settled. While the state holds a rotated pair that could not be persisted,
 * hydration retries persisting it instead. A persistence failure propagates.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 */
export async function hydrateSession<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
): Promise<void> {
    const ledger = ledgerOf(state);
    const epoch = ledger.epoch;

    await ledger.operations.run(async () => {
        if (ledger.epoch !== epoch) {
            return;
        }

        if (ledger.unsaved !== null) {
            await saveRotation(state, context, ledger, epoch, ledger.unsaved);

            return;
        }

        const snapshot = await context.persistence.load();

        if (ledger.epoch === epoch) {
            adopt(state, ledger, snapshot);
        }
    });
}

/**
 * Exchange credentials for a session, load the current user, and persist the
 * session over whatever is persisted. When loading the user or persisting
 * fails, the session is rolled back and the failure rethrown.
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
    const ledger = ledgerOf(state);
    const started = ledger.epoch;
    const result = await context.api.login(credentials, context.device());

    if (ledger.epoch !== started) {
        return SUPERSEDED;
    }

    if (result.kind === 'interactionRequired') {
        return result;
    }

    const epoch = replaceSession(state, ledger, result.tokens);

    try {
        const user = await context.api.currentUser();

        await ledger.operations.run(() =>
            overwrite(ledger, epoch, revision => context.persistence.saveIf(revision, result.tokens)),
        );

        if (ledger.epoch !== epoch) {
            return SUPERSEDED;
        }

        state.user = user;
    } catch (error) {
        if (ledger.epoch === epoch) {
            await clearSession(state, context).catch(() => undefined);
        }

        throw error;
    }

    return AUTHENTICATED;
}

/**
 * Exchange the refresh credential for a new session.
 *
 * A rotated pair is persisted before it is applied; when it cannot be persisted
 * it is kept in state all the same, since the server has spent the old pair. A
 * refusal, or a return to pending authentication, clears the session unless
 * another context has meanwhile persisted a newer one, which is adopted
 * instead. A transient or other failure keeps the tokens. The refresh
 * credential may be absent from state, as when it travels in a cookie; the
 * gateway decides whether it can refresh without one.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 * @returns what the refresh did
 */
export async function refreshSession<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
): Promise<RefreshOutcome> {
    const ledger = ledgerOf(state);
    const epoch = ledger.epoch;
    const presented = ledger.revision;
    const result = await requestRefresh(context, state.refreshToken);

    if (ledger.epoch !== epoch) {
        return SUPERSEDED;
    }

    if (result.kind === 'refreshed') {
        return ledger.operations.run(() => storeRotation(state, context, ledger, epoch, result.tokens));
    }

    if (result.kind === 'retryable' || result.kind === 'failed') {
        return result;
    }

    return ledger.operations.run(() => discard(state, context, ledger, epoch, presented, result));
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
    const ledger = ledgerOf(state);
    const epoch = advance(ledger);

    try {
        await context.api.logout(state.refreshToken);
    } catch {
        // The local session is discarded regardless of server reachability.
    }

    if (ledger.epoch === epoch) {
        await clearSession(state, context);
    }
}

/**
 * Clear all session state, then remove whatever session is persisted. State is
 * cleared before the returned promise settles; a persistence failure
 * propagates.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 */
export async function clearSession<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
): Promise<void> {
    const ledger = ledgerOf(state);
    const epoch = replaceSession(state, ledger, null);

    await ledger.operations.run(() => overwrite(ledger, epoch, revision => context.persistence.clearIf(revision)));
}

/**
 * Fetch and store the current user when a session is present but no user record
 * has been loaded yet. Concurrent callers of one session share the single
 * in-flight request, and failures are swallowed.
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

    const ledger = ledgerOf(state);

    if (ledger.rehydration?.epoch === ledger.epoch) {
        return ledger.rehydration.promise;
    }

    const rehydration = { epoch: ledger.epoch, promise: fetchCurrentUser(state, context, ledger) };

    ledger.rehydration = rehydration;

    try {
        await rehydration.promise;
    } finally {
        if (ledger.rehydration === rehydration) {
            ledger.rehydration = null;
        }
    }
}

/**
 * Fetch the current user into state, swallowing a dead-session failure and
 * discarding a user that arrives after the session was replaced.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 * @param ledger - the state's ledger
 */
async function fetchCurrentUser<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
    ledger: Ledger,
): Promise<void> {
    const epoch = ledger.epoch;

    try {
        const user = await context.api.currentUser();

        if (ledger.epoch === epoch) {
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
 * Persist a rotated pair, keeping it in state and reporting the failure when it
 * cannot be persisted.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 * @param ledger - the state's ledger
 * @param epoch - the epoch the refresh started under
 * @param tokens - the rotated pair
 * @returns what the refresh did
 */
async function storeRotation<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
    ledger: Ledger,
    epoch: object,
    tokens: SessionTokens,
): Promise<RefreshOutcome> {
    if (ledger.epoch !== epoch) {
        return SUPERSEDED;
    }

    try {
        return await saveRotation(state, context, ledger, epoch, tokens);
    } catch (error) {
        if (ledger.epoch !== epoch) {
            return SUPERSEDED;
        }

        setTokens(state, tokens);
        ledger.unsaved = tokens;

        return { kind: 'failed', error };
    }
}

/**
 * Persist a rotated pair at the state's revision and apply it, or adopt the
 * session another context persisted first. A persistence failure propagates.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 * @param ledger - the state's ledger
 * @param epoch - the epoch the rotation belongs to
 * @param tokens - the rotated pair
 * @returns refreshed when the state holds a session afterwards, otherwise
 * superseded
 */
async function saveRotation<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
    ledger: Ledger,
    epoch: object,
    tokens: SessionTokens,
): Promise<RefreshOutcome> {
    const result = await context.persistence.saveIf(ledger.revision, tokens);

    if (result.status === 'saved') {
        ledger.revision = result.revision;
    }

    if (ledger.epoch !== epoch) {
        return SUPERSEDED;
    }

    if (result.status === 'saved') {
        setTokens(state, tokens);
        ledger.unsaved = null;

        return REFRESHED;
    }

    adopt(state, ledger, result.current);

    return state.accessToken === null ? SUPERSEDED : REFRESHED;
}

/**
 * Clear a refused session from persistence when it is still at the revision the
 * refresh presented, otherwise adopt the session persisted since.
 *
 * @param state - the mutable session state
 * @param context - the session core context
 * @param ledger - the state's ledger
 * @param epoch - the epoch the refresh started under
 * @param presented - the revision the refresh presented
 * @param outcome - what the refresh reports when the session is cleared
 * @returns the outcome, or refreshed when a persisted session was adopted
 */
async function discard<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
    ledger: Ledger,
    epoch: object,
    presented: number,
    outcome: RefreshOutcome,
): Promise<RefreshOutcome> {
    if (ledger.epoch !== epoch) {
        return SUPERSEDED;
    }

    const result = await context.persistence.clearIf(presented).catch(() => null);

    if (ledger.epoch !== epoch) {
        return SUPERSEDED;
    }

    if (result?.status === 'changed') {
        adopt(state, ledger, result.current);
    } else {
        // A failed clear keeps the revision, so the dead session stored at it
        // is never adopted back.
        if (result !== null) {
            ledger.revision = result.revision;
        }

        signOut(state, ledger);
    }

    return state.accessToken === null ? outcome : REFRESHED;
}

/**
 * Write over whatever is persisted, retrying at each revision another context
 * wrote meanwhile. Nothing is written once the epoch has moved on.
 *
 * @param ledger - the state's ledger
 * @param epoch - the epoch the write belongs to
 * @param write - the conditional write, given the revision it expects
 */
async function overwrite(
    ledger: Ledger,
    epoch: object,
    write: (revision: number) => Promise<SessionSaveResult | SessionClearResult>,
): Promise<void> {
    if (ledger.epoch !== epoch) {
        return;
    }

    let result = await write(ledger.revision);

    while (result.status === 'changed') {
        result = await write(result.current.revision);
    }

    ledger.revision = result.revision;
}

/**
 * Bring the state in line with a snapshot at another revision. A higher
 * revision is another context's session; a lower one means the store was reset,
 * which signs the state out. The state's own revision changes nothing.
 *
 * @param state - the mutable session state
 * @param ledger - the state's ledger
 * @param snapshot - the persisted snapshot
 */
function adopt(state: SessionState<SessionUser>, ledger: Ledger, snapshot: SessionSnapshot): void {
    if (snapshot.revision > ledger.revision && snapshot.tokens !== null) {
        replaceSession(state, ledger, snapshot.tokens);
    } else if (snapshot.revision !== ledger.revision) {
        signOut(state, ledger);
    }

    ledger.revision = snapshot.revision;
}

/**
 * Discard the state's session, if it holds one.
 *
 * @param state - the mutable session state
 * @param ledger - the state's ledger
 */
function signOut(state: SessionState<SessionUser>, ledger: Ledger): void {
    if (state.accessToken !== null) {
        replaceSession(state, ledger, null);
    }
}

/**
 * Replace the state's session and drop its user, advancing the epoch.
 *
 * @param state - the mutable session state
 * @param ledger - the state's ledger
 * @param tokens - the new session's tokens, or null to sign out
 * @returns the new epoch
 */
function replaceSession(state: SessionState<SessionUser>, ledger: Ledger, tokens: SessionTokens | null): object {
    ledger.unsaved = null;
    state.user = null;

    if (tokens === null) {
        state.accessToken = null;
        state.refreshToken = null;
        state.expiresAtEpochMs = null;
    } else {
        setTokens(state, tokens);
    }

    return advance(ledger);
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
 * Advance the epoch, invalidating every in-flight step.
 *
 * @param ledger - the state's ledger
 * @returns the new epoch
 */
function advance(ledger: Ledger): object {
    ledger.epoch = {};

    return ledger.epoch;
}

/**
 * Resolve the state's ledger, starting one on first use.
 *
 * @param state - the session state
 * @returns the ledger
 */
function ledgerOf(state: object): Ledger {
    const existing = ledgers.get(state);

    if (existing !== undefined) {
        return existing;
    }

    const ledger: Ledger = {
        epoch: {},
        revision: 0,
        unsaved: null,
        operations: new InProcessSessionLock(),
        rehydration: null,
    };

    ledgers.set(state, ledger);

    return ledger;
}
