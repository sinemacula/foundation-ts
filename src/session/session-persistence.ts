/**
 * Revisioned session snapshot port, kept apart from key-value storage so a
 * platform can back credentials with an asynchronous secure store.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { SessionTokens } from './session-tokens';

/**
 * A persisted session: the tokens of one sign-in, under the lineage every
 * rotation of that sign-in keeps.
 */
export interface PersistedSession {
    /** Marks the sign-in the session descends from, so a rotation is told apart from a new sign-in. */
    readonly lineage: string;

    /** The session's tokens. */
    readonly tokens: SessionTokens;
}

/**
 * The persisted session at one revision. The revision grows with every write,
 * clearing included, and is 0 before the first.
 */
export interface SessionSnapshot {
    /** The revision of the last write. */
    readonly revision: number;

    /** The persisted session, or null when none is persisted. */
    readonly session: PersistedSession | null;
}

/**
 * What a conditional write expects to find: a revision and the lineage stored
 * at it, so a write never lands on another sign-in's snapshot even when a store
 * reset reuses its revision.
 */
export interface SessionVersion {
    /** The expected revision. */
    readonly revision: number;

    /** The expected lineage, or null when no session is expected. */
    readonly lineage: string | null;
}

/**
 * A conditional write refused because the snapshot is no longer at the expected
 * version.
 */
export interface SessionSnapshotChanged {
    /** The write was not made. */
    readonly status: 'changed';

    /** The snapshot as it stands. */
    readonly current: SessionSnapshot;
}

/** The result of {@link SessionPersistence.saveIf}. */
export type SessionSaveResult =
    | {
          /** The session was persisted. */
          readonly status: 'saved';

          /** The revision the write produced. */
          readonly revision: number;
      }
    | SessionSnapshotChanged;

/** The result of {@link SessionPersistence.clearIf}. */
export type SessionClearResult =
    | {
          /** The session was removed. */
          readonly status: 'cleared';

          /** The revision the write produced. */
          readonly revision: number;
      }
    | SessionSnapshotChanged;

/**
 * Persists the session snapshot. Each conditional write compares revision and
 * lineage and writes atomically, across every context sharing the store, and
 * every operation observes each write that resolved before it was called, in
 * any context, so no context presents a refresh token another has spent. A
 * failure to read or write rejects; it never reads as an empty store.
 */
export interface SessionPersistence {
    /**
     * Read the persisted snapshot.
     *
     * @returns the snapshot, at revision 0 with no session when nothing was
     * ever written
     */
    load(): Promise<SessionSnapshot>;

    /**
     * Persist the session when the snapshot is still at the expected version.
     *
     * @returns the new revision, or the snapshot that changed meanwhile
     */
    saveIf(expected: SessionVersion, session: PersistedSession): Promise<SessionSaveResult>;

    /**
     * Remove the persisted session when the snapshot is still at the expected
     * version, keeping the revision growing.
     *
     * @returns the new revision, or the snapshot that changed meanwhile
     */
    clearIf(expected: SessionVersion): Promise<SessionClearResult>;
}
