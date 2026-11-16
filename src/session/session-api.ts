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

import type { LoginResult, RefreshResult } from './session-outcomes';
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
 * The default credential shape: an email address and a password.
 */
export interface PasswordCredentials {
    /** The submitted account email address. */
    readonly email: string;

    /** The submitted account password. */
    readonly password: string;
}

/**
 * Typed access to the session endpoints.
 */
export interface SessionApi<U extends SessionUser = SessionUser, C = PasswordCredentials> {
    /**
     * Exchange credentials and a device fingerprint for a session.
     *
     * @param credentials - the credentials submitted by the user
     * @param device - the device fingerprint
     * @returns the issued tokens, or the pending session awaiting a further
     * step
     */
    login(credentials: C, device: SessionDevice): Promise<LoginResult>;

    /**
     * Exchange the refresh credential for a new session. Implementations
     * classify failures into the result rather than throwing.
     *
     * @param refreshToken - the refresh token from the current session, or null
     * when none is held (as when the refresh credential travels in a cookie)
     * @returns the refresh result
     */
    refresh(refreshToken: string | null): Promise<RefreshResult>;

    /**
     * Invalidate the current session server-side.
     *
     * @param refreshToken - the refresh token from the current session, or null
     * when none is held
     */
    logout(refreshToken: string | null): Promise<void>;

    /**
     * Fetch the authenticated user record.
     *
     * @returns the mapped user
     */
    currentUser(): Promise<U>;
}
