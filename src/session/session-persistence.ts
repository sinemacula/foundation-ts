/**
 * Session persistence port.
 *
 * The asynchronous store the session core keeps its one token snapshot in, kept
 * apart from the synchronous key-value storage that holds preferences so a
 * platform can back credentials with an asynchronous secure store. Every write
 * is conditional on the revision the writer last saw, so contexts sharing the
 * store (browser tabs) can tell a session another context wrote from their own,
 * and every write is awaited before the session core reports a sign-in or
 * refresh as successful.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { SessionTokens } from './session-tokens';

/**
 * The persisted session at one revision. The revision grows with every write,
 * clearing included, and is 0 before the first.
 */
export interface SessionSnapshot {
    /** The revision of the last write. */
    readonly revision: number;

    /** The persisted tokens, or null when no session is persisted. */
    readonly tokens: SessionTokens | null;
}

/**
 * A conditional write refused because the snapshot is no longer at the expected
 * revision.
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
          /** The tokens were persisted. */
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
 * Persists the session's token snapshot. Each conditional write compares and
 * writes atomically, across every context sharing the store. A failure to read
 * or write rejects; it never reads as an empty store.
 */
export interface SessionPersistence {
    /**
     * Read the persisted snapshot.
     *
     * @returns the snapshot, at revision 0 with no tokens when nothing was
     * ever written
     */
    load(): Promise<SessionSnapshot>;

    /**
     * Persist the tokens when the snapshot is still at the expected revision.
     *
     * @param expectedRevision - the revision the caller last saw
     * @param tokens - the tokens to persist
     * @returns the new revision, or the snapshot that changed meanwhile
     */
    saveIf(expectedRevision: number, tokens: SessionTokens): Promise<SessionSaveResult>;

    /**
     * Remove the persisted session when the snapshot is still at the expected
     * revision, keeping the revision growing.
     *
     * @param expectedRevision - the revision the caller last saw
     * @returns the new revision, or the snapshot that changed meanwhile
     */
    clearIf(expectedRevision: number): Promise<SessionClearResult>;
}
