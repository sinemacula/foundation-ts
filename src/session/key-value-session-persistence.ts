/**
 * Key-value {@link SessionPersistence}: the snapshot is one JSON value, so a
 * single storage write replaces the whole session.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { KeyValueStorage } from '../storage/key-value-storage';
import { isRecord } from '../support/is-record';
import { InProcessSessionLock } from './in-process-session-lock';
import { SessionError } from './session-error';
import type { SessionLock } from './session-lock';
import type {
    SessionClearResult,
    SessionPersistence,
    SessionSaveResult,
    SessionSnapshot,
    SessionSnapshotChanged,
} from './session-persistence';
import { DEFAULT_SESSION_STORAGE_KEYS } from './session-storage-keys';
import type { SessionTokens } from './session-tokens';

/**
 * Options for {@link KeyValueSessionPersistence}.
 */
export interface KeyValueSessionPersistenceOptions {
    /** The key the snapshot is stored under. Default `DEFAULT_SESSION_STORAGE_KEYS.session`. */
    readonly key?: string;

    /** The lock every context writing the key shares. Default {@link InProcessSessionLock}, which suffices only for one context. */
    readonly lock?: SessionLock;
}

/**
 * A conditional write that was made.
 */
interface Written<S extends 'saved' | 'cleared'> {
    /** What the write did. */
    readonly status: S;

    /** The revision the write produced. */
    readonly revision: number;
}

const EMPTY: SessionSnapshot = { revision: 0, tokens: null };

/**
 * Persist the session snapshot in a key-value storage adapter.
 *
 * The storage must throw when it cannot read or write: a storage that swallows
 * failures would report a lost write as saved and an unreadable session as
 * none. A stored value that is not a snapshot rejects a load with a
 * {@link SessionError}, while a conditional write treats it as an empty store
 * at revision 0, so a sign-in or clear can replace it.
 */
export class KeyValueSessionPersistence implements SessionPersistence {
    /** The storage adapter the snapshot is written to. */
    readonly #storage: KeyValueStorage;

    /** The key the snapshot is written under. */
    readonly #key: string;

    /** Serialises every read-compare-write. */
    readonly #lock: SessionLock;

    constructor(storage: KeyValueStorage, options: KeyValueSessionPersistenceOptions = {}) {
        this.#storage = storage;
        this.#key = options.key ?? DEFAULT_SESSION_STORAGE_KEYS.session;
        this.#lock = options.lock ?? new InProcessSessionLock();
    }

    /**
     * Read the snapshot.
     */
    load(): Promise<SessionSnapshot> {
        return new Promise(resolve => {
            resolve(this.#read(parseSnapshot));
        });
    }

    /**
     * Persist the tokens at the next revision when the snapshot is still at the
     * expected one.
     */
    saveIf(expectedRevision: number, tokens: SessionTokens): Promise<SessionSaveResult> {
        return this.#writeIf(expectedRevision, tokens, 'saved');
    }

    /**
     * Store an empty snapshot at the next revision when the snapshot is still
     * at the expected one.
     */
    clearIf(expectedRevision: number): Promise<SessionClearResult> {
        return this.#writeIf(expectedRevision, null, 'cleared');
    }

    /**
     * Write the tokens at the next revision, while holding the lock, when the
     * snapshot is still at the expected revision.
     *
     * @param tokens - the tokens to write, or null to clear
     * @param status - the status a successful write reports
     */
    #writeIf<S extends 'saved' | 'cleared'>(
        expectedRevision: number,
        tokens: SessionTokens | null,
        status: S,
    ): Promise<Written<S> | SessionSnapshotChanged> {
        return this.#lock.run(
            () =>
                new Promise(resolve => {
                    const current = this.#read(parseOrEmpty);

                    if (current.revision !== expectedRevision) {
                        resolve({ status: 'changed', current });

                        return;
                    }

                    const revision = current.revision + 1;

                    this.#storage.set(this.#key, JSON.stringify({ revision, tokens }));
                    resolve({ status, revision });
                }),
        );
    }

    /**
     * Read the snapshot synchronously.
     *
     * @returns the stored snapshot, or the empty one when none is stored
     */
    #read(parse: (raw: string) => SessionSnapshot): SessionSnapshot {
        const raw = this.#storage.get(this.#key);

        return raw === null ? EMPTY : parse(raw);
    }
}

/**
 * Parse a stored snapshot.
 *
 * @throws {@link SessionError} when the value is not a snapshot
 */
function parseSnapshot(raw: string): SessionSnapshot {
    let value: unknown;

    try {
        value = JSON.parse(raw);
    } catch (error) {
        throw unreadable(error);
    }

    if (!isRecord(value)) {
        throw unreadable();
    }

    const revision = value['revision'];
    const tokens = value['tokens'];

    if (!isRevision(revision)) {
        throw unreadable();
    }

    return { revision, tokens: tokens === null ? null : parseTokens(tokens) };
}

/**
 * Parse a stored snapshot, reading a value that is not one as the empty store.
 */
function parseOrEmpty(raw: string): SessionSnapshot {
    try {
        return parseSnapshot(raw);
    } catch {
        return EMPTY;
    }
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
 * Build the error for a stored value that is not a snapshot.
 *
 * @param cause - the parse failure, when there was one
 */
function unreadable(cause?: unknown): SessionError {
    return new SessionError('The persisted session could not be read.', cause === undefined ? undefined : { cause });
}
