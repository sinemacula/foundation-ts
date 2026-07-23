/**
 * Session state shape.
 *
 * The mutable state every session-core transition operates on. Each platform's
 * store owns an instance of this shape (the web pinia store's state satisfies
 * it structurally) and forwards it explicitly into the transitions.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { SessionUser } from './session-user';

/**
 * The mutable session state the core transitions read and write.
 */
export interface SessionState {
    /** The bearer token for the active session, or null when signed out. */
    accessToken: string | null;

    /** The refresh token for the active session, or null when not issued. */
    refreshToken: string | null;

    /** Absolute session expiry in epoch milliseconds, or null when unknown. */
    expiresAtEpochMs: number | null;

    /** The authenticated user record, or null when not yet loaded. */
    user: SessionUser | null;
}
