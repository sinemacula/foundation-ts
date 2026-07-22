/**
 * Session storage keys.
 *
 * The keys the session persists under in the application storage adapter,
 * shared by every platform's session module.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * The storage keys the session persists under.
 *
 * PUBLIC CONTRACT: live user sessions (and e2e suites) seed these exact
 * localStorage keys, so the defaults are load-bearing and versioned - renaming
 * any of them is a breaking change requiring an explicit migration. Keys are
 * matched RAW against cross-tab storage-event keys, so the storage adapter must
 * persist un-namespaced (namespaced wrapping is unsupported here; applications
 * wanting a prefix set it in these options so event keys still match).
 */
export interface SessionStorageKeys {
    /** Default 'auth.access_token'. */
    readonly accessToken: string;

    /** Default 'auth.refresh_token'. */
    readonly refreshToken: string;

    /** Default 'auth.expires_at'. */
    readonly expiresAt: string;

    /** Default 'auth.device_uuid'. */
    readonly deviceUuid: string;
}

/**
 * The versioned default storage keys every platform's session module starts
 * from.
 */
export const DEFAULT_SESSION_STORAGE_KEYS: SessionStorageKeys = {
    accessToken: 'auth.access_token',
    refreshToken: 'auth.refresh_token',
    expiresAt: 'auth.expires_at',
    deviceUuid: 'auth.device_uuid',
};
