/**
 * Record {@link SessionPersistence}: the snapshot is one JSON record in a
 * {@link SessionRecordStore}, so each conditional write is one atomic swap.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { isRecord } from '../support/is-record';
import { SessionError } from './session-error';
import type {
    PersistedSession,
    SessionClearResult,
    SessionPersistence,
    SessionSaveResult,
    SessionSnapshot,
    SessionSnapshotChanged,
    SessionVersion,
} from './session-persistence';
import type { SessionRecordStore } from './session-record-store';
import type { SessionTokens } from './session-tokens';

/**
 * A conditional write that was made.
 */
interface Written<S extends 'saved' | 'cleared'> {
    /** What the write did. */
    readonly status: S;

    /** The revision the write produced. */
    readonly revision: number;
}

/**
 * A conditional write that failed inside its swap, storing nothing.
 */
interface Failed {
    /** Why it failed. */
    readonly error: unknown;
}

const EMPTY: SessionSnapshot = { revision: 0, session: null };

/**
 * Persist the session snapshot as one JSON record,
 * `{ revision, session: { lineage, tokens } }`, with a null `session` once
 * cleared.
 *
 * Every context sharing the session must persist it through the same store,
 * whose linearisable swaps make the conditional writes atomic and visible to
 * every context once they resolve. A stored record that is not a snapshot
 * rejects a load with a {@link SessionError}, while a conditional write treats
 * it as an empty store at revision 0, so a sign-in or clear can replace it.
 */
export class RecordSessionPersistence implements SessionPersistence {
    /** The store the record is kept in. */
    readonly #store: SessionRecordStore;

    constructor(store: SessionRecordStore) {
        this.#store = store;
    }

    /**
     * Read the snapshot.
     */
    async load(): Promise<SessionSnapshot> {
        return snapshotOf(await this.#store.read(), parseSnapshot);
    }

    /**
     * Persist the session at the next revision when the snapshot is still at
     * the expected version.
     */
    saveIf(expected: SessionVersion, session: PersistedSession): Promise<SessionSaveResult> {
        return this.#writeIf(expected, session, 'saved');
    }

    /**
     * Store an empty snapshot at the next revision when the snapshot is still
     * at the expected version.
     */
    clearIf(expected: SessionVersion): Promise<SessionClearResult> {
        return this.#writeIf(expected, null, 'cleared');
    }

    /**
     * Write the session at the next revision, in one swap, when the snapshot is
     * still at the expected version. The outcome is reported only once the swap
     * has resolved.
     *
     * @param session - the session to write, or null to clear
     * @param status - the status a successful write reports
     * @throws {@link SessionError} when the revision cannot grow any further,
     * or the store resolved the swap without deciding it
     */
    async #writeIf<S extends 'saved' | 'cleared'>(
        expected: SessionVersion,
        session: PersistedSession | null,
        status: S,
    ): Promise<Written<S> | SessionSnapshotChanged> {
        let decision: Written<S> | SessionSnapshotChanged | null = null;
        let failure: Failed | null = null;

        await this.#store.swap(record => {
            try {
                const current = snapshotOf(record, parseOrEmpty);

                if (current.revision !== expected.revision || lineageOf(current) !== expected.lineage) {
                    decision = { status: 'changed', current };

                    return null;
                }

                const revision = nextRevision(current.revision);
                const next = serialise(revision, session);

                decision = { status, revision };

                return next;
            } catch (error) {
                failure = { error };

                return null;
            }
        });

        return settle<Written<S> | SessionSnapshotChanged>(decision, failure);
    }
}

/**
 * Report what a swap decided.
 *
 * @throws the failure the swap recorded, or a {@link SessionError} when the
 * store never decided the swap
 */
function settle<D>(decision: D | null, failure: Failed | null): D {
    if (failure !== null) {
        throw failure.error;
    }

    if (decision === null) {
        throw new SessionError('The session record store resolved a swap without deciding it.');
    }

    return decision;
}

/**
 * Read a stored record as a snapshot.
 *
 * @returns the parsed snapshot, or the empty one when nothing is stored
 */
function snapshotOf(record: string | null, parse: (record: string) => SessionSnapshot): SessionSnapshot {
    return record === null ? EMPTY : parse(record);
}

/**
 * The revision after the given one.
 *
 * @throws {@link SessionError} when it is not a safe integer
 */
function nextRevision(revision: number): number {
    const next = revision + 1;

    if (!Number.isSafeInteger(next)) {
        throw new SessionError('The persisted session revision cannot grow any further.');
    }

    return next;
}

/**
 * The lineage of the snapshot's session, or null when it holds none.
 */
function lineageOf(snapshot: SessionSnapshot): string | null {
    return snapshot.session?.lineage ?? null;
}

/**
 * Serialise a snapshot with its fields in a fixed order, whatever the shape of
 * the objects handed in.
 */
function serialise(revision: number, session: PersistedSession | null): string {
    if (session === null) {
        return JSON.stringify({ revision, session });
    }

    const { accessToken, refreshToken, expiresAtEpochMs } = session.tokens;

    return JSON.stringify({
        revision,
        session: { lineage: session.lineage, tokens: { accessToken, refreshToken, expiresAtEpochMs } },
    });
}

/**
 * Parse a stored snapshot.
 *
 * @throws {@link SessionError} when the record is not a snapshot
 */
function parseSnapshot(record: string): SessionSnapshot {
    let value: unknown;

    try {
        value = JSON.parse(record);
    } catch (error) {
        throw unreadable(error);
    }

    if (!isRecord(value)) {
        throw unreadable();
    }

    const revision = value['revision'];
    const session = value['session'];

    if (!isRevision(revision)) {
        throw unreadable();
    }

    return { revision, session: session === null ? null : parseSession(session) };
}

/**
 * Parse a stored snapshot, reading a record that is not one as the empty store.
 */
function parseOrEmpty(record: string): SessionSnapshot {
    try {
        return parseSnapshot(record);
    } catch {
        return EMPTY;
    }
}

/**
 * Parse the stored session.
 *
 * @throws {@link SessionError} when the value is not a session
 */
function parseSession(value: unknown): PersistedSession {
    if (!isRecord(value)) {
        throw unreadable();
    }

    const { lineage, tokens } = value;

    if (typeof lineage !== 'string' || lineage === '') {
        throw unreadable();
    }

    return { lineage, tokens: parseTokens(tokens) };
}

/**
 * Parse the stored tokens.
 *
 * @throws {@link SessionError} when the value is not a token set
 */
function parseTokens(value: unknown): SessionTokens {
    if (!isRecord(value)) {
        throw unreadable();
    }

    const { accessToken, refreshToken, expiresAtEpochMs } = value;

    if (
        typeof accessToken !== 'string' ||
        accessToken === '' ||
        (refreshToken !== null && typeof refreshToken !== 'string') ||
        (expiresAtEpochMs !== null && !isFiniteNumber(expiresAtEpochMs))
    ) {
        throw unreadable();
    }

    return { accessToken, refreshToken, expiresAtEpochMs };
}

/**
 * Check for a revision a write produced: a positive safe integer.
 */
function isRevision(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0;
}

/**
 * Check for a finite number.
 */
function isFiniteNumber(value: unknown): value is number {
    return Number.isFinite(value);
}

/**
 * Build the error for a stored record that is not a snapshot.
 *
 * @param cause - the parse failure, when there was one
 */
function unreadable(cause?: unknown): SessionError {
    return new SessionError('The persisted session could not be read.', cause === undefined ? undefined : { cause });
}
