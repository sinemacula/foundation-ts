/**
 * Session token set.
 *
 * The normalised token bundle returned by every {@link SessionApi} call that
 * establishes or renews a session. Wire-format parsing happens at the API
 * gateway boundary, never in the session lifecycle, so consumers only ever see
 * epoch milliseconds.
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
