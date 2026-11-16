/**
 * Session storage keys.
 *
 * The key the key-value session persistence adapter writes the session snapshot
 * under, plus the device identifier key, shared by every platform's session
 * module.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * The storage keys the session persists under.
 *
 * Existing persisted sessions and seeded test sessions are read under these
 * exact keys, so renaming a default is a breaking change. Platforms that
 * observe storage changes from other contexts match on these raw keys, so a
 * prefix belongs in these options rather than in a namespacing storage wrapper.
 */
export interface SessionStorageKeys {
    /** The revisioned session snapshot. Default 'auth.session'. */
    readonly session: string;

    /** Default 'auth.device_uuid'. */
    readonly deviceUuid: string;
}

/**
 * The versioned default storage keys every platform's session module starts
 * from.
 */
export const DEFAULT_SESSION_STORAGE_KEYS: SessionStorageKeys = {
    session: 'auth.session',
    deviceUuid: 'auth.device_uuid',
};
