/**
 * Key-value session persistence adapter.
 *
 * Implements {@link SessionPersistence} over the synchronous key-value storage
 * port, writing the snapshot under the three session storage keys so browser
 * storage keeps working unchanged. Expiry persists as an epoch-millisecond
 * string; any other persisted value reads back as an unknown expiry.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { KeyValueStorage } from '../storage/key-value-storage';
import type { SessionPersistence } from './session-persistence';
import type { SessionStorageKeys } from './session-storage-keys';
import { DEFAULT_SESSION_STORAGE_KEYS } from './session-storage-keys';
import type { SessionTokens } from './session-tokens';

/**
 * Persist the session snapshot in a key-value storage adapter.
 */
export class KeyValueSessionPersistence implements SessionPersistence {
    /** The storage adapter the snapshot is written to. */
    readonly #storage: KeyValueStorage;

    /** The keys the snapshot is written under. */
    readonly #keys: SessionStorageKeys;

    constructor(storage: KeyValueStorage, keys: SessionStorageKeys = DEFAULT_SESSION_STORAGE_KEYS) {
        this.#storage = storage;
        this.#keys = keys;
    }

    /**
     * Read the snapshot, treating a missing access token as no session.
     */
    load(): Promise<SessionTokens | null> {
        return new Promise((resolve) => {
            resolve(this.#read());
        });
    }

    /**
     * Write every key of the snapshot, removing the keys whose value is null.
     */
    save(tokens: SessionTokens): Promise<void> {
        return new Promise((resolve) => {
            this.#storage.set(this.#keys.accessToken, tokens.accessToken);
            this.#write(this.#keys.refreshToken, tokens.refreshToken);
            this.#write(
                this.#keys.expiresAt,
                tokens.expiresAtEpochMs === null ? null : String(tokens.expiresAtEpochMs),
            );
            resolve();
        });
    }

    /**
     * Remove every key of the snapshot.
     */
    clear(): Promise<void> {
        return new Promise((resolve) => {
            this.#storage.remove(this.#keys.accessToken);
            this.#storage.remove(this.#keys.refreshToken);
            this.#storage.remove(this.#keys.expiresAt);
            resolve();
        });
    }

    /**
     * Read the snapshot synchronously.
     *
     * @returns the stored tokens, or null when no access token is stored
     */
    #read(): SessionTokens | null {
        const accessToken = this.#storage.get(this.#keys.accessToken);

        if (accessToken === null) {
            return null;
        }

        const expiresAt = this.#storage.get(this.#keys.expiresAt);

        return {
            accessToken,
            refreshToken: this.#storage.get(this.#keys.refreshToken),
            expiresAtEpochMs: /^\d+$/.test(expiresAt ?? '') ? Number(expiresAt) : null,
        };
    }

    /**
     * Store a value, or remove the key when the value is null.
     *
     * @param key - the storage key
     * @param value - the value to store, or null to remove the key
     */
    #write(key: string, value: string | null): void {
        if (value === null) {
            this.#storage.remove(key);
        } else {
            this.#storage.set(key, value);
        }
    }
}
