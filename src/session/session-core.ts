/**
 * Platform-agnostic session transitions over an explicit state; every token
 * write is awaited before a transition reports success.
 *
 * The latest explicit action wins: a sign-in or hydration discards its result
 * once a later sign-in, sign-out, clear or adoption has started, and a sign-out
 * or clear removes whatever session is then held unless a sign-in has landed
 * since. A refresh or user fetch applies only to the session it started on,
 * which a rotation keeps. Persistence operations on one state run one at a
 * time, each re-checking supersession before it writes. A stored snapshot
 * replaces the state only at a higher revision, so a rotated pair that could
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
    /** Started by every sign-in, sign-out and clear, and by adopting another context's session. */
    epoch: object;

    /** The session refreshes and user fetches belong to, kept across a rotation and replaced by any other change. */
    session: object;

    /** The identity of the session the state holds, kept until that session is replaced or cleared. */
    identity: object;

    /** The session the latest sign-in to land installed, or null. */
    signIn: object | null;

    /** The persisted revision the state is based on. */
    revision: number;

    /** The rotated pair the state holds that could not be persisted, or null. */
    unsaved: SessionTokens | null;

    /** Runs the state's persistence operations one at a time. */
    readonly operations: InProcessSessionLock;

    /** The in-flight user fetch and the session it serves, or null. */
    rehydration: Rehydration | null;
}

/**
 * A user fetch shared by the callers of one session.
 */
interface Rehydration {
    /** The session the fetch serves. */
    readonly session: object;

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
 */
export async function hydrateSession<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
): Promise<void> {
    const ledger = ledgerOf(state);
    const epoch = ledger.epoch;

    /** Whether no sign-in, sign-out, clear or adoption has started since. */
    const isCurrent = (): boolean => ledger.epoch === epoch;

    await ledger.operations.run(async () => {
        if (!isCurrent()) {
            return;
        }

        if (ledger.unsaved !== null) {
            await saveRotation(state, context, ledger, isCurrent, ledger.unsaved);

            return;
        }

        const snapshot = await context.persistence.load();

        if (isCurrent()) {
            adopt(state, ledger, snapshot);
        }
    });
}

/**
 * Exchange credentials for a session, persist it over whatever is persisted,
 * then load the current user. Persisting first lets a refresh the user fetch
 * triggers rotate the persisted pair. When persisting or loading the user
 * fails, the session is rolled back and the failure rethrown.
 */
export async function loginWithCredentials<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
    credentials: C,
): Promise<LoginOutcome> {
    const ledger = ledgerOf(state);
    const epoch = advance(ledger);
    const result = await context.api.login(credentials, context.device());

    if (ledger.epoch !== epoch) {
        return SUPERSEDED;
    }

    if (result.kind === 'interactionRequired') {
        return result;
    }

    const session = replaceSession(state, ledger, result.tokens);

    /** Whether the sign-in is still the latest and its session still held. */
    const isCurrent = (): boolean => ledger.epoch === epoch && ledger.session === session;

    ledger.signIn = session;

    try {
        await ledger.operations.run(() =>
            overwrite(isCurrent, ledger, revision => context.persistence.saveIf(revision, result.tokens)),
        );

        if (!isCurrent()) {
            return SUPERSEDED;
        }

        const user = await context.api.currentUser();

        if (!isCurrent()) {
            return SUPERSEDED;
        }

        state.user = user;
    } catch (error) {
        if (isCurrent()) {
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
 * it is kept in state all the same, since the server has spent the old pair,
 * and the next refresh persists it before asking the server, reporting the
 * failure while it still cannot. A refusal, or a return to pending
 * authentication, clears the session unless another context has meanwhile
 * persisted a newer one, which is adopted instead; a failure to clear it is
 * reported as such. A transient or other failure keeps the tokens. The refresh
 * credential may be absent from state, as when it travels in a cookie; the
 * gateway decides whether it can refresh without one.
 */
export async function refreshSession<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
): Promise<RefreshOutcome> {
    const ledger = ledgerOf(state);
    const session = ledger.session;

    /** Whether the session the refresh started with is still held. */
    const isCurrent = (): boolean => ledger.session === session;

    if (ledger.unsaved !== null) {
        const retried = await ledger.operations.run(async () =>
            ledger.unsaved === null ? REFRESHED : storeRotation(state, context, ledger, isCurrent, ledger.unsaved),
        );

        if (retried.kind !== 'refreshed' || !isCurrent()) {
            return retried;
        }
    }

    const presented = ledger.revision;
    const result = await requestRefresh(context, state.refreshToken);

    if (!isCurrent()) {
        return SUPERSEDED;
    }

    if (result.kind === 'refreshed') {
        return ledger.operations.run(() => storeRotation(state, context, ledger, isCurrent, result.tokens));
    }

    if (result.kind === 'retryable' || result.kind === 'failed') {
        return result;
    }

    return ledger.operations.run(() => discard(state, context, ledger, isCurrent, presented, result));
}

/**
 * Best-effort invalidate the session server-side, then discard whatever session
 * is held, including one adopted from another context meanwhile. A sign-in that
 * lands while the server call is in flight is left in place.
 */
export async function logoutSession<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
): Promise<void> {
    const ledger = ledgerOf(state);
    const signIn = ledger.signIn;

    /** Whether no sign-in has landed since the sign-out started. */
    const isCurrent = (): boolean => ledger.signIn === signIn;

    advance(ledger);
    ledger.session = {};

    try {
        await context.api.logout(state.refreshToken);
    } catch {
        // The local session is discarded regardless of server reachability.
    }

    // Under the lock, so a hydration queued meanwhile cannot land after it.
    await ledger.operations.run(async () => {
        if (isCurrent()) {
            replaceSession(state, ledger, null);
            await overwrite(isCurrent, ledger, revision => context.persistence.clearIf(revision));
        }
    });
}

/**
 * Clear all session state, then remove whatever session is persisted. State is
 * cleared before the returned promise settles; a persistence failure
 * propagates.
 */
export async function clearSession<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
): Promise<void> {
    const ledger = ledgerOf(state);
    const signIn = ledger.signIn;

    advance(ledger);
    replaceSession(state, ledger, null);

    await ledger.operations.run(() =>
        overwrite(
            () => ledger.signIn === signIn,
            ledger,
            revision => context.persistence.clearIf(revision),
        ),
    );
}

/**
 * Fetch and store the current user when a session is present but no user record
 * has been loaded yet. Concurrent callers of one session share the single
 * in-flight request, and failures are swallowed.
 */
export async function rehydrateSessionUser<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
): Promise<void> {
    if (state.accessToken === null || state.user !== null) {
        return;
    }

    const ledger = ledgerOf(state);

    if (ledger.rehydration?.session === ledger.session) {
        return ledger.rehydration.promise;
    }

    const rehydration = { session: ledger.session, promise: fetchCurrentUser(state, context, ledger) };

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
 * Identify the session the state holds, so a consumer can tell a rotation of
 * one session from its replacement. The identity is kept across a rotation and
 * is new for every sign-in and every session adopted from another context. A
 * sign-out keeps it until the session is cleared.
 *
 * @returns the session's identity, or null when the state holds no session
 */
export function sessionIdentity(state: SessionState<SessionUser>): object | null {
    return state.accessToken === null ? null : ledgerOf(state).identity;
}

/**
 * Fetch the current user into state, swallowing a dead-session failure and
 * discarding a user that arrives after the session was replaced.
 */
async function fetchCurrentUser<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
    ledger: Ledger,
): Promise<void> {
    const session = ledger.session;

    try {
        const user = await context.api.currentUser();

        if (ledger.session === session) {
            state.user = user;
        }
    } catch {
        // A dead session is handled by the 401 refresh or session-loss watcher.
    }
}

/**
 * Ask the gateway for a refresh, classifying a thrown failure with the default
 * policy.
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
 */
async function storeRotation<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
    ledger: Ledger,
    isCurrent: () => boolean,
    tokens: SessionTokens,
): Promise<RefreshOutcome> {
    if (!isCurrent()) {
        return SUPERSEDED;
    }

    try {
        return await saveRotation(state, context, ledger, isCurrent, tokens);
    } catch (error) {
        if (!isCurrent()) {
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
 * @returns refreshed when the state holds a session afterwards, otherwise
 * superseded
 */
async function saveRotation<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
    ledger: Ledger,
    isCurrent: () => boolean,
    tokens: SessionTokens,
): Promise<RefreshOutcome> {
    const result = await context.persistence.saveIf(ledger.revision, tokens);

    if (result.status === 'saved') {
        ledger.revision = result.revision;
    }

    if (!isCurrent()) {
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
 * refresh presented, otherwise adopt the session persisted since. When it
 * cannot be cleared it is still discarded from state, and the failure reported.
 *
 * @param outcome - what the refresh reports when the session is cleared
 * @returns the outcome, refreshed when a persisted session was adopted, or the
 * failure to clear it
 */
async function discard<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<U, C>,
    ledger: Ledger,
    isCurrent: () => boolean,
    presented: number,
    outcome: RefreshOutcome,
): Promise<RefreshOutcome> {
    if (!isCurrent()) {
        return SUPERSEDED;
    }

    let result: SessionClearResult;

    try {
        result = await context.persistence.clearIf(presented);
    } catch (error) {
        if (!isCurrent()) {
            return SUPERSEDED;
        }

        // The revision is kept, so the stored dead session is never re-adopted.
        replaceSession(state, ledger, null);

        return { kind: 'failed', error };
    }

    if (!isCurrent()) {
        return SUPERSEDED;
    }

    if (result.status === 'changed') {
        adopt(state, ledger, result.current);
    } else {
        ledger.revision = result.revision;
        replaceSession(state, ledger, null);
    }

    return state.accessToken === null ? outcome : REFRESHED;
}

/**
 * Write over whatever is persisted, retrying at each revision another context
 * wrote meanwhile. Nothing more is written once the write is superseded.
 *
 * @param write - the conditional write, given the revision it expects
 */
async function overwrite(
    isCurrent: () => boolean,
    ledger: Ledger,
    write: (revision: number) => Promise<SessionSaveResult | SessionClearResult>,
): Promise<void> {
    let revision = ledger.revision;

    while (isCurrent()) {
        const result = await write(revision);

        if (result.status !== 'changed') {
            ledger.revision = result.revision;

            return;
        }

        revision = result.current.revision;
    }
}

/**
 * Bring the state in line with a snapshot at another revision, starting a new
 * epoch when that changes the state's session. A higher revision is another
 * context's session; a lower one means the store was reset, which signs the
 * state out. The state's own revision changes nothing, so a rotated pair that
 * could not be persisted is never traded back for the spent pair still stored.
 */
function adopt(state: SessionState<SessionUser>, ledger: Ledger, snapshot: SessionSnapshot): void {
    const newer = snapshot.revision > ledger.revision ? snapshot.tokens : null;

    if (newer !== null || (snapshot.revision !== ledger.revision && state.accessToken !== null)) {
        replaceSession(state, ledger, newer);
        advance(ledger);
    }

    ledger.revision = snapshot.revision;
}

/**
 * Replace the state's session and drop its user.
 *
 * @param tokens - the new session's tokens, or null to sign out
 * @returns the new session
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

    ledger.session = {};
    ledger.identity = ledger.session;

    return ledger.session;
}

/**
 * Write a token set onto the state.
 */
function setTokens(state: SessionState<SessionUser>, tokens: SessionTokens): void {
    state.accessToken = tokens.accessToken;
    state.refreshToken = tokens.refreshToken;
    state.expiresAtEpochMs = tokens.expiresAtEpochMs;
}

/**
 * Start a new epoch, superseding every transition started before it.
 */
function advance(ledger: Ledger): object {
    ledger.epoch = {};

    return ledger.epoch;
}

/**
 * Resolve the state's ledger, starting one on first use.
 */
function ledgerOf(state: object): Ledger {
    const existing = ledgers.get(state);

    if (existing !== undefined) {
        return existing;
    }

    const ledger: Ledger = {
        epoch: {},
        session: {},
        identity: {},
        signIn: null,
        revision: 0,
        unsaved: null,
        operations: new InProcessSessionLock(),
        rehydration: null,
    };

    ledgers.set(state, ledger);

    return ledger;
}
