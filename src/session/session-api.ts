/**
 * Session API port.
 *
 * The session module depends on this contract, never on a concrete gateway.
 * Each platform ships a default gateway over its HTTP client; applications with
 * diverging wire conventions substitute their own implementation.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { SessionTokens } from './session-tokens';
import type { SessionUser } from './session-user';

/**
 * The device fingerprint submitted alongside login credentials.
 */
export interface SessionDevice {
    /** The stable per-device identifier. */
    readonly uuid: string;

    /** The operating-system label reported for the device. */
    readonly os: string;
}

/**
 * Typed access to the session endpoints.
 */
export interface SessionApi<
    U extends SessionUser = SessionUser,
    C = {
        /** The submitted account email address. */
        email: string;

        /** The submitted account password. */
        password: string;
    },
> {
    /**
     * Exchange credentials and a device fingerprint for a session.
     *
     * @param credentials - the credentials submitted by the user
     * @param device - the device fingerprint
     * @returns the normalised session tokens
     */
    login(credentials: C, device: SessionDevice): Promise<SessionTokens>;

    /**
     * Exchange a refresh token for a new session.
     *
     * @param refreshToken - the refresh token from the current session
     * @returns the normalised session tokens
     */
    refresh(refreshToken: string): Promise<SessionTokens>;

    /**
     * Invalidate the current session server-side.
     */
    logout(): Promise<void>;

    /**
     * Fetch the authenticated user record.
     *
     * @returns the mapped user
     */
    currentUser(): Promise<U>;
}
