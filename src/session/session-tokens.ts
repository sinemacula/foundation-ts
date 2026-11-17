/**
 * Normalised session token set; the gateway parses the wire format.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * The tokens describing an authenticated session.
 */
export interface SessionTokens {
    /** The bearer token attached to authenticated requests. */
    readonly accessToken: string;

    /** The token exchanged for a new session; null when not issued. */
    readonly refreshToken: string | null;

    /** Absolute expiry in epoch milliseconds; null disables proactive refresh. */
    readonly expiresAtEpochMs: number | null;
}
