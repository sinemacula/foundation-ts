/**
 * Key-value {@link SessionRecordStore}: the record is one storage value, each
 * swap a read and write under a {@link SessionLock}.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { KeyValueStorage } from '../storage/key-value-storage';
import { InProcessSessionLock } from './in-process-session-lock';
import type { SessionLock } from './session-lock';
import type { SessionRecordStore } from './session-record-store';
import { DEFAULT_SESSION_STORAGE_KEYS } from './session-storage-keys';

/**
 * Options for {@link KeyValueSessionRecordStore}.
 */
export interface KeyValueSessionRecordStoreOptions {
    /** The key the record is stored under. Default `DEFAULT_SESSION_STORAGE_KEYS.session`. */
    readonly key?: string;

    /** The lock every context writing the key shares. Default {@link InProcessSessionLock}, which suffices only for one context. */
    readonly lock?: SessionLock;
}

/**
 * Keep the record under one key of a key-value storage adapter.
 *
 * Linearisable only when every context writing the key shares the lock and the
 * storage shows each context every write made before it reads. Browser
 * localStorage shared by tabs does not: a tab can be granted a lock before it
 * sees what another tab wrote under it. The storage must throw when it cannot
 * read or write.
 */
export class KeyValueSessionRecordStore implements SessionRecordStore {
    /** The storage adapter the record is written to. */
    readonly #storage: KeyValueStorage;

    /** The key the record is written under. */
    readonly #key: string;

    /** Serialises every swap. */
    readonly #lock: SessionLock;

    constructor(storage: KeyValueStorage, options: KeyValueSessionRecordStoreOptions = {}) {
        this.#storage = storage;
        this.#key = options.key ?? DEFAULT_SESSION_STORAGE_KEYS.session;
        this.#lock = options.lock ?? new InProcessSessionLock();
    }

    /**
     * Read the record.
     */
    read(): Promise<string | null> {
        return new Promise(resolve => {
            resolve(this.#storage.get(this.#key));
        });
    }

    /**
     * Read the record, decide and write it while holding the lock.
     */
    swap(decide: (current: string | null) => string | null): Promise<void> {
        return this.#lock.run(
            () =>
                new Promise(resolve => {
                    const next = decide(this.#storage.get(this.#key));

                    if (next !== null) {
                        this.#storage.set(this.#key, next);
                    }

                    resolve();
                }),
        );
    }
}
