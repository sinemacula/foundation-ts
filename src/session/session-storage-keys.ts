/**
 * Storage keys for the session snapshot and the device identifier.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * The storage keys the session persists under. Renaming a default is a breaking
 * change, and cross-context storage listeners match on the raw keys, so a
 * prefix belongs here rather than in a namespacing storage wrapper.
 */
export interface SessionStorageKeys {
    /** The revisioned session snapshot. Default 'auth.session'. */
    readonly session: string;

    /** Default 'auth.device_uuid'. */
    readonly deviceUuid: string;
}

/**
 * The default storage keys every platform's session module starts from.
 */
export const DEFAULT_SESSION_STORAGE_KEYS: SessionStorageKeys = {
    session: 'auth.session',
    deviceUuid: 'auth.device_uuid',
};
