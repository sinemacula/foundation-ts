/**
 * Platform-agnostic session transitions over an explicit state; every token
 * write is awaited before a transition reports success.
 *
 * The latest explicit action wins: a sign-in discards its result once a later
 * sign-in, sign-out or clear has started, or a hydration started after it has
 * replaced the session, and a sign-out or clear removes whatever session is
 * then held unless a sign-in has landed since. A refresh or user fetch applies
 * only to the session it started on, which every rotation of it keeps, from
 * this context or another, and every other change replaces. Credential
 * exchanges run one at a time under the exchange lock, across every context
 * sharing it, and a state's persistence operations one at a time, each
 * re-checking supersession before it writes. A stored snapshot of the held
 * sign-in at a higher revision only updates the tokens; any other version
 * replaces the session, or signs it out when the snapshot holds none or its
 * revision is lower, so a rotated pair that could not be persisted is never
 * traded back for the spent pair still stored.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { InProcessSessionLock } from './in-process-session-lock';
import type { PasswordCredentials, SessionApi, SessionDevice } from './session-api';
import { SessionError } from './session-error';
import type { SessionLock } from './session-lock';
import type { LoginOutcome, LoginResult, RefreshOutcome, RefreshResult } from './session-outcomes';
import { classifyRefreshError } from './session-outcomes';
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

/**
 * The route-free context slice the session-core transitions consume.
 */
export interface SessionCoreContext<U extends SessionUser = SessionUser, C = PasswordCredentials> {
    /** The asynchronous store the session snapshot persists to. */
    readonly persistence: SessionPersistence;

    /** The session API gateway. */
    readonly api: SessionApi<U, C>;

    /** Resolve the stable device fingerprint. */
    readonly device: () => SessionDevice;

    /** Create the lineage of a new sign-in: a non-empty string unique to it, such as a random UUID; not a secret. */
    readonly createLineage: () => string;

    /** Serialises every sign-in, refresh and sign-out exchange across the contexts sharing the persisted session, such as a Web Lock, and is never the persistence's own lock; a request that never settles holds every later exchange, so give the HTTP client a timeout that aborts it. Default: one in-process lock per state, which suffices only while one state uses the persisted session. */
    readonly exchangeLock?: SessionLock;
}

/**
 * The bookkeeping the transitions keep for one state.
 */
interface Ledger {
    /** Advanced by every sign-in that installs a session, every sign-out and clear, and adopting another sign-in's session. */
    epoch: object;

    /** The session refreshes and user fetches belong to, kept across a rotation and replaced by any other change. */
    session: object;

    /** The identity of the session the state holds, kept until that session is replaced or cleared. */
    identity: object;

    /** The lineage of the session the state holds, or null when it holds none. */
    lineage: string | null;

    /** Replaced by every sign-in as it starts and every sign-out and clear, and by replacing the session from a later snapshot. */
    signInAttempt: object;

    /** The session the latest sign-in to land installed, or null. */
    signIn: object | null;

    /** The persisted version the state is based on. */
    version: SessionVersion;

    /** The rotated session the state holds that could not be persisted, or null. */
    unsaved: PersistedSession | null;

    /** Runs the state's persistence operations one at a time. */
    readonly operations: InProcessSessionLock;

    /** The exchange lock used when the context supplies none. */
    readonly exchange: InProcessSessionLock;

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

/**
 * What a transition works on: the state, its ledger and its persistence.
 */
interface Scope {
    /** The session state. */
    readonly state: SessionState<SessionUser>;

    /** The state's ledger. */
    readonly ledger: Ledger;

    /** The persistence the context supplies. */
    readonly persistence: SessionPersistence;
}

/**
 * How a hydration or refresh tells whether it still applies.
 */
interface Turn {
    /** Whether the transition still applies. */
    readonly isCurrent: () => boolean;

    /** The sign-in attempt current when the transition started. */
    readonly attempt: object;
}

/**
 * A sign-in whose session is installed and persisted.
 */
interface Installed {
    /** The session is installed. */
    readonly kind: 'installed';

    /** Whether the sign-in is still the latest and its session still held. */
    readonly isCurrent: () => boolean;
}

/**
 * A sign-in's credential exchange.
 */
interface Exchange {
    /** The sign-in attempt. */
    readonly attempt: object;

    /** The lineage the sign-in's session is persisted under. */
    readonly lineage: string;

    /** Send the sign-in request, presenting the given refresh token. */
    readonly send: (refreshToken: string | null) => Promise<LoginResult>;

    /** Sign an issued session out on the server, swallowing a failure. */
    readonly signOut: (tokens: SessionTokens) => Promise<void>;
}

/**
 * A refresh, as captured when it was called.
 */
interface Refresh {
    /** The persisted version the state was based on. */
    readonly started: SessionVersion;

    /** The lineage of the session being refreshed. */
    readonly lineage: string;

    /** Whether the refreshed session is still held, and the sign-in attempt then current. */
    readonly turn: Turn;
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
 * A rotation of the held session updates its tokens, keeping the user. Any
 * other session replaces the state's and drops the user, so the caller
 * refetches it with {@link rehydrateSessionUser} once hydration has settled.
 * While the state holds a rotated pair that could not be persisted, hydration
 * retries persisting it instead. A persistence failure propagates.
 */
export async function hydrateSession<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<NoInfer<U>, C>,
): Promise<void> {
    const scope = scopeOf(state, context);
    const { ledger } = scope;
    const epoch = ledger.epoch;
    const turn: Turn = { isCurrent: () => ledger.epoch === epoch, attempt: ledger.signInAttempt };

    await ledger.operations.run(async () => {
        if (!turn.isCurrent()) {
            return;
        }

        if (ledger.unsaved !== null) {
            await saveRotation(scope, turn, ledger.version, ledger.unsaved);

            return;
        }

        const snapshot = await scope.persistence.load();

        if (turn.isCurrent()) {
            adopt(scope, snapshot, turn.attempt);
        }
    });
}

/**
 * Exchange credentials for a session, persist it over whatever is persisted,
 * then load the current user. Persisting first lets a refresh the user fetch
 * triggers rotate the persisted pair. The held refresh token is presented, so
 * the server may supersede the held session. When persisting or loading the
 * user fails, the session is rolled back and the failure rethrown.
 *
 * @throws {@link SessionError} when the context creates an empty lineage,
 * before anything is sent
 */
export async function loginWithCredentials<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<NoInfer<U>, C>,
    credentials: C,
): Promise<LoginOutcome> {
    const scope = scopeOf(state, context);
    const lineage = createLineage(context);
    const device = context.device();
    const attempt = {};

    scope.ledger.signInAttempt = attempt;

    const exchanged = await exchangeLockOf(context, scope.ledger).run(() =>
        exchangeCredentials(scope, {
            attempt,
            lineage,
            send: refreshToken => context.api.login(credentials, device, refreshToken),
            signOut: async tokens => {
                try {
                    await context.api.logout(tokens);
                } catch {
                    // The orphaned server session is left to expire.
                }
            },
        }),
    );

    if (exchanged.kind !== 'installed') {
        return exchanged;
    }

    try {
        const user = await context.api.currentUser();

        if (!exchanged.isCurrent()) {
            return SUPERSEDED;
        }

        state.user = user;
    } catch (error) {
        if (exchanged.isCurrent()) {
            await clearSession(state, context).catch(() => undefined);
        }

        throw error;
    }

    return AUTHENTICATED;
}

/**
 * Exchange the refresh credential for a new session.
 *
 * Under the exchange lock the persisted snapshot is read first: a version
 * another context wrote since the call is adopted instead of presenting a token
 * that may be spent, and a failed read reports the failure without a request. A
 * rotated pair is persisted before it is applied; when it cannot be persisted
 * it is kept in state all the same, since the server has spent the old pair,
 * and the next refresh persists it before asking the server, reporting the
 * failure while it still cannot. A refusal, or a return to pending
 * authentication, clears the session unless another context has meanwhile
 * persisted a newer one, which is adopted instead; a failure to clear it is
 * reported as such. A transient or other failure keeps the tokens. A signed-out
 * state makes no request. A rotation that could not be persisted is invisible
 * to other contexts, so one of them presenting the spent token after the
 * server's grace window can still get the session revoked. Likewise, when a
 * sign-in's session is held by no context and neither clearing the stored
 * session nor signing that session out succeeds, a refresh can present its
 * cookie for the stored session.
 */
export async function refreshSession<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<NoInfer<U>, C>,
): Promise<RefreshOutcome> {
    const scope = scopeOf(state, context);
    const { ledger } = scope;
    const session = ledger.session;
    const lineage = ledger.lineage;

    if (lineage === null) {
        return SUPERSEDED;
    }

    const refresh: Refresh = {
        started: ledger.version,
        lineage,
        turn: { isCurrent: () => ledger.session === session, attempt: ledger.signInAttempt },
    };

    try {
        return await exchangeLockOf(context, ledger).run(() => exchangeRefresh(scope, context.api, refresh));
    } catch (error) {
        return { kind: 'failed', error };
    }
}

/**
 * Sign out: the session is cleared from state at once and from persistence
 * next, then the server is asked to invalidate it, authenticated by its own
 * captured tokens. The server is asked only while the persisted session is
 * still the one this sign-out left, so a sign-in that landed meanwhile, in any
 * context, is never signed out; a skipped or failed request leaves the server
 * session to expire. The request holds the exchange lock until it settles.
 * Resolves once the server attempt has settled or been skipped, which does not
 * confirm revocation; a persistence failure is then rethrown.
 */
export async function logoutSession<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<NoInfer<U>, C>,
): Promise<void> {
    const scope = scopeOf(state, context);
    const { ledger } = scope;
    const tokens = heldTokens(state);
    const captured = ledger.version;

    ledger.signInAttempt = {};

    const [cleared] = await Promise.allSettled([reset(scope)]);
    const owned = cleared.status === 'fulfilled' ? cleared.value : captured;

    if (tokens !== null && owned !== null) {
        await signOutRemotely(scope, context, tokens, owned);
    }

    if (cleared.status === 'rejected') {
        throw cleared.reason;
    }
}

/**
 * Clear all session state, then remove whatever session is persisted. State is
 * cleared before the returned promise settles; a persistence failure
 * propagates.
 */
export async function clearSession<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<NoInfer<U>, C>,
): Promise<void> {
    const scope = scopeOf(state, context);

    scope.ledger.signInAttempt = {};
    await reset(scope);
}

/**
 * Fetch and store the current user when a session is present but no user record
 * has been loaded yet. Concurrent callers of one session share the single
 * in-flight request, and failures are swallowed.
 */
export async function rehydrateSessionUser<U extends SessionUser, C>(
    state: SessionState<U>,
    context: SessionCoreContext<NoInfer<U>, C>,
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
 * one session from its replacement. The identity is kept across every rotation,
 * including one adopted from another context, and is new for every sign-in and
 * every other session adopted.
 *
 * @returns the session's identity, or null when the state holds no session
 */
export function sessionIdentity(state: SessionState<SessionUser>): object | null {
    return state.accessToken === null ? null : ledgerOf(state).identity;
}

/**
 * Send a sign-in, install the session it issues and persist it, all while
 * holding the exchange lock. A session that cannot be persisted, or that a
 * later sign-in overtook before it was, is rolled back before the lock is
 * released, so no context holds a session whose version was never written. An
 * issued session no context holds is signed out on the server, deleting its
 * cookie before another context's exchange can present it. A session issued
 * after the sign-in was overtaken also signs the state out when its refresh
 * credential was not handed back, since the cookie carrying it no longer
 * belongs to the held session.
 *
 * @returns the installed sign-in, or what the sign-in reports instead
 */
async function exchangeCredentials(
    scope: Scope,
    exchange: Exchange,
): Promise<Installed | Exclude<LoginOutcome, typeof AUTHENTICATED>> {
    const { state, ledger } = scope;

    /** Whether no other sign-in, sign-out or clear has started since. */
    const isLatest = (): boolean => ledger.signInAttempt === exchange.attempt;

    if (!isLatest()) {
        return SUPERSEDED;
    }

    const result = await exchange.send(state.refreshToken);

    if (!isLatest()) {
        if (result.kind === 'authenticated') {
            await exchange.signOut(result.tokens);

            // Its cookie may have replaced the held session's refresh cookie.
            if (result.tokens.refreshToken === null) {
                await reset(scope).catch(() => undefined);
            }
        }

        return SUPERSEDED;
    }

    if (result.kind === 'interactionRequired') {
        return result;
    }

    const persisted: PersistedSession = { lineage: exchange.lineage, tokens: result.tokens };
    const session = replaceSession(state, ledger, persisted);

    advance(ledger);
    ledger.signIn = session;

    /** Whether the installed session is still held. */
    const isInstalled = (): boolean => ledger.session === session;

    /** Whether the sign-in is still the latest and its session still held. */
    const isCurrent = (): boolean => isLatest() && isInstalled();

    let saved: SessionVersion | null;

    try {
        saved = await ledger.operations.run(() =>
            overwrite(ledger, isCurrent, persisted.lineage, expected => scope.persistence.saveIf(expected, persisted)),
        );
    } catch (error) {
        await rollBack(scope, isInstalled);
        await exchange.signOut(result.tokens);

        throw error;
    }

    if (saved === null) {
        await rollBack(scope, isInstalled);
        await exchange.signOut(result.tokens);

        return SUPERSEDED;
    }

    return isCurrent() ? { kind: 'installed', isCurrent } : SUPERSEDED;
}

/**
 * Remove a sign-in's session that was never persisted, while it is still held,
 * leaving any later sign-in attempt in place.
 */
async function rollBack(scope: Scope, isInstalled: () => boolean): Promise<void> {
    if (isInstalled()) {
        await reset(scope).catch(() => undefined);
    }
}

/**
 * Refresh while holding the exchange lock: bring the state in line with the
 * persisted session, then ask the server and persist what it answers.
 */
async function exchangeRefresh<U extends SessionUser, C>(
    scope: Scope,
    api: SessionApi<U, C>,
    refresh: Refresh,
): Promise<RefreshOutcome> {
    const { state, ledger } = scope;
    const { turn } = refresh;
    const settled = await (ledger.unsaved === null ? reconcile(scope, refresh) : retryUnsaved(scope, turn));

    if (settled !== null) {
        return settled;
    }

    if (!turn.isCurrent()) {
        return SUPERSEDED;
    }

    const presented = ledger.version;
    const result = await requestRefresh(api, state.refreshToken);

    if (!turn.isCurrent()) {
        return SUPERSEDED;
    }

    if (result.kind === 'refreshed') {
        const rotation: PersistedSession = { lineage: refresh.lineage, tokens: result.tokens };

        return ledger.operations.run(() => storeRotation(scope, turn, presented, rotation));
    }

    if (result.kind === 'retryable' || result.kind === 'failed') {
        return result;
    }

    return ledger.operations.run(() => discard(scope, turn, presented, result));
}

/**
 * Read the persisted snapshot before a refresh, adopting a version written
 * since the refresh was called instead of asking the server.
 *
 * @returns what the refresh reports, or null when the server is to be asked
 */
function reconcile(scope: Scope, refresh: Refresh): Promise<RefreshOutcome | null> {
    const { turn } = refresh;

    return scope.ledger.operations.run(async () => {
        let snapshot: SessionSnapshot;

        try {
            snapshot = await scope.persistence.load();
        } catch (error) {
            return { kind: 'failed', error };
        }

        if (isSameVersion(versionOf(snapshot), refresh.started)) {
            return null;
        }

        if (!turn.isCurrent()) {
            return SUPERSEDED;
        }

        adopt(scope, snapshot, turn.attempt);

        return turn.isCurrent() ? REFRESHED : SUPERSEDED;
    });
}

/**
 * Persist a rotated pair a refresh could not persist, before asking the server
 * again.
 *
 * @returns what the refresh reports, or null when the server is to be asked
 */
async function retryUnsaved(scope: Scope, turn: Turn): Promise<RefreshOutcome | null> {
    const { ledger } = scope;
    const retried = await ledger.operations.run(() =>
        ledger.unsaved === null
            ? Promise.resolve(REFRESHED)
            : storeRotation(scope, turn, ledger.version, ledger.unsaved),
    );

    return retried.kind === 'refreshed' ? null : retried;
}

/**
 * Sign the captured session out on the server, under the exchange lock, while
 * the persisted session is still at the version the sign-out owns. A failed
 * read skips the request; every failure is swallowed.
 */
async function signOutRemotely<U extends SessionUser, C>(
    scope: Scope,
    context: SessionCoreContext<U, C>,
    tokens: SessionTokens,
    owned: SessionVersion,
): Promise<void> {
    const { ledger, persistence } = scope;

    try {
        await exchangeLockOf(context, ledger).run(async () => {
            const snapshot = await ledger.operations.run(() => persistence.load());

            if (isSameVersion(versionOf(snapshot), owned)) {
                await context.api.logout(tokens);
            }
        });
    } catch {
        // The local session is gone; the server session is left to expire.
    }
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
    api: SessionApi<U, C>,
    refreshToken: string | null,
): Promise<RefreshResult> {
    try {
        return await api.refresh(refreshToken);
    } catch (error) {
        return { kind: classifyRefreshError(error), error };
    }
}

/**
 * Persist a rotated pair, keeping it in state and reporting the failure when it
 * cannot be persisted.
 */
async function storeRotation(
    scope: Scope,
    turn: Turn,
    expected: SessionVersion,
    rotation: PersistedSession,
): Promise<RefreshOutcome> {
    if (!turn.isCurrent()) {
        return SUPERSEDED;
    }

    try {
        return await saveRotation(scope, turn, expected, rotation);
    } catch (error) {
        if (!turn.isCurrent()) {
            return SUPERSEDED;
        }

        setTokens(scope.state, rotation.tokens);
        scope.ledger.unsaved = rotation;

        return { kind: 'failed', error };
    }
}

/**
 * Persist a rotated pair at the expected version and apply it, or adopt the
 * session another context persisted first. A persistence failure propagates.
 *
 * @returns refreshed when the state still holds the rotated session, otherwise
 * superseded
 */
async function saveRotation(
    scope: Scope,
    turn: Turn,
    expected: SessionVersion,
    rotation: PersistedSession,
): Promise<RefreshOutcome> {
    const { state, ledger } = scope;
    const result = await scope.persistence.saveIf(expected, rotation);

    if (result.status === 'saved') {
        ledger.version = { revision: result.revision, lineage: rotation.lineage };
    }

    if (!turn.isCurrent()) {
        return SUPERSEDED;
    }

    if (result.status === 'saved') {
        setTokens(state, rotation.tokens);
        ledger.unsaved = null;

        return REFRESHED;
    }

    adopt(scope, result.current, turn.attempt);

    return turn.isCurrent() ? REFRESHED : SUPERSEDED;
}

/**
 * Clear a refused session from persistence when it is still at the version the
 * refresh presented, otherwise adopt the session persisted since. When it
 * cannot be cleared it is still discarded from state, and the failure reported.
 *
 * @param outcome - what the refresh reports when the session is cleared
 * @returns the outcome, refreshed when a rotation of the session was adopted,
 * or the failure to clear it
 */
async function discard(
    scope: Scope,
    turn: Turn,
    presented: SessionVersion,
    outcome: RefreshOutcome,
): Promise<RefreshOutcome> {
    const { state, ledger } = scope;

    if (!turn.isCurrent()) {
        return SUPERSEDED;
    }

    let result: SessionClearResult;

    try {
        result = await scope.persistence.clearIf(presented);
    } catch (error) {
        if (!turn.isCurrent()) {
            return SUPERSEDED;
        }

        // The version is kept, so the stored dead session is never re-adopted.
        replaceSession(state, ledger, null);

        return { kind: 'failed', error };
    }

    if (!turn.isCurrent()) {
        return SUPERSEDED;
    }

    if (result.status === 'changed') {
        adopt(scope, result.current, turn.attempt);

        return turn.isCurrent() ? REFRESHED : SUPERSEDED;
    }

    ledger.version = { revision: result.revision, lineage: null };
    replaceSession(state, ledger, null);

    return outcome;
}

/**
 * Sign the state out and remove whatever session is persisted, until a sign-in
 * lands. State is cleared before the returned promise settles.
 *
 * @returns the version the clear produced, or null when a sign-in landed first
 */
function reset(scope: Scope): Promise<SessionVersion | null> {
    const { state, ledger, persistence } = scope;
    const signIn = ledger.signIn;

    advance(ledger);
    replaceSession(state, ledger, null);

    return ledger.operations.run(() =>
        overwrite(
            ledger,
            () => ledger.signIn === signIn,
            null,
            expected => persistence.clearIf(expected),
        ),
    );
}

/**
 * Write over whatever is persisted, retrying at each version another context
 * wrote meanwhile. Nothing more is written once the write is superseded.
 *
 * @param lineage - the lineage the write stores, or null for a clear
 * @param write - the conditional write, given the version it expects
 * @returns the version written, or null when superseded first
 */
async function overwrite(
    ledger: Ledger,
    isCurrent: () => boolean,
    lineage: string | null,
    write: (expected: SessionVersion) => Promise<SessionSaveResult | SessionClearResult>,
): Promise<SessionVersion | null> {
    let expected = ledger.version;

    while (isCurrent()) {
        const result = await write(expected);

        if (result.status !== 'changed') {
            ledger.version = { revision: result.revision, lineage };

            return ledger.version;
        }

        expected = versionOf(result.current);
    }

    return null;
}

/**
 * Bring the state in line with a snapshot at another version. A rotation of the
 * held session updates its tokens only. A lower revision means the store was
 * reset, which signs the state out; any other session replaces the state's,
 * starting a new epoch and superseding the sign-in attempt current when the
 * adopting transition started. The state's own version changes nothing, so a
 * rotated pair that could not be persisted is never traded back for the spent
 * pair still stored.
 */
function adopt(scope: Scope, snapshot: SessionSnapshot, attempt: object): void {
    const { state, ledger } = scope;
    const held = ledger.version;
    const version = versionOf(snapshot);

    ledger.version = version;

    if (isSameVersion(version, held)) {
        return;
    }

    const session = version.revision < held.revision ? null : snapshot.session;

    if (session !== null && session.lineage === ledger.lineage) {
        setTokens(state, session.tokens);
        ledger.unsaved = null;

        return;
    }

    if (session !== null || state.accessToken !== null) {
        replaceSession(state, ledger, session);
        advance(ledger);

        if (ledger.signInAttempt === attempt) {
            ledger.signInAttempt = {};
        }
    }
}

/**
 * Replace the state's session and drop its user.
 *
 * @param session - the new session, or null to sign out
 * @returns the new session
 */
function replaceSession(state: SessionState<SessionUser>, ledger: Ledger, session: PersistedSession | null): object {
    ledger.unsaved = null;
    ledger.lineage = session === null ? null : session.lineage;
    state.user = null;

    if (session === null) {
        state.accessToken = null;
        state.refreshToken = null;
        state.expiresAtEpochMs = null;
    } else {
        setTokens(state, session.tokens);
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
 * Read the tokens of the session the state holds.
 *
 * @returns the tokens, or null when the state holds no session
 */
function heldTokens(state: SessionState<SessionUser>): SessionTokens | null {
    const { accessToken, refreshToken, expiresAtEpochMs } = state;

    return accessToken === null ? null : { accessToken, refreshToken, expiresAtEpochMs };
}

/**
 * Create and check the lineage of a new sign-in.
 *
 * @throws {@link SessionError} when it is not a non-empty string
 */
function createLineage(context: Pick<SessionCoreContext, 'createLineage'>): string {
    const lineage: unknown = context.createLineage();

    if (typeof lineage !== 'string' || lineage === '') {
        throw new SessionError('The session lineage must be a non-empty string.');
    }

    return lineage;
}

/**
 * Identify a snapshot's version.
 */
function versionOf(snapshot: SessionSnapshot): SessionVersion {
    return { revision: snapshot.revision, lineage: snapshot.session === null ? null : snapshot.session.lineage };
}

/**
 * Check whether two versions are the same.
 */
function isSameVersion(left: SessionVersion, right: SessionVersion): boolean {
    return left.revision === right.revision && left.lineage === right.lineage;
}

/**
 * Start a new epoch, superseding every transition started before it.
 */
function advance(ledger: Ledger): object {
    ledger.epoch = {};

    return ledger.epoch;
}

/**
 * Resolve the lock the context's credential exchanges run under.
 */
function exchangeLockOf(context: Pick<SessionCoreContext, 'exchangeLock'>, ledger: Ledger): SessionLock {
    return context.exchangeLock ?? ledger.exchange;
}

/**
 * Resolve what a transition on the state works on.
 */
function scopeOf(state: SessionState<SessionUser>, context: Pick<SessionCoreContext, 'persistence'>): Scope {
    return { state, ledger: ledgerOf(state), persistence: context.persistence };
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
        lineage: null,
        signInAttempt: {},
        signIn: null,
        version: { revision: 0, lineage: null },
        unsaved: null,
        operations: new InProcessSessionLock(),
        exchange: new InProcessSessionLock(),
        rehydration: null,
    };

    ledgers.set(state, ledger);

    return ledger;
}
