/**
 * Session persistence port.
 *
 * The asynchronous store the session core keeps its one token snapshot in, kept
 * apart from the synchronous key-value storage that holds preferences so a
 * platform can back credentials with an asynchronous secure store. Every write
 * is awaited before the session core reports a sign-in or refresh as
 * successful.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { SessionTokens } from './session-tokens';

/**
 * Persists the session's token snapshot.
 */
export interface SessionPersistence {
    /**
     * Read the persisted snapshot.
     *
     * @returns the persisted tokens, or null when no session is persisted
     */
    load(): Promise<SessionTokens | null>;

    /**
     * Replace the persisted snapshot.
     *
     * @param tokens - the tokens to persist
     */
    save(tokens: SessionTokens): Promise<void>;

    /**
     * Remove the persisted snapshot.
     */
    clear(): Promise<void>;
}
