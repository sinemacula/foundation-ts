/**
 * Session API port; applications with other wire conventions supply their own.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { LoginResult, RefreshResult } from './session-outcomes';
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
     * @param refreshToken - the refresh token of the session the state holds,
     * or null; presenting it lets the server revoke that session as superseded,
     * best-effort, when it is the current token of the same identity and
     * principal
     * @returns the issued tokens, or the pending session awaiting a further
     * step
     */
    login(credentials: C, device: SessionDevice, refreshToken: string | null): Promise<LoginResult>;

    /**
     * Exchange the refresh credential for a new session. Implementations
     * classify failures into the result rather than throwing.
     *
     * Runs while the session core holds its exchange lock, so it must not
     * trigger a refresh itself.
     *
     * @param refreshToken - the refresh token from the current session, or null
     * when none is held (as when the refresh credential travels in a cookie)
     */
    refresh(refreshToken: string | null): Promise<RefreshResult>;

    /**
     * Invalidate the given session server-side, authenticating with its own
     * tokens rather than whatever session is current when the request is sent.
     *
     * @param tokens - the tokens of the session being signed out, captured
     * before it was cleared locally
     */
    logout(tokens: SessionTokens): Promise<void>;

    /**
     * Fetch the authenticated user record.
     */
    currentUser(): Promise<U>;
}
