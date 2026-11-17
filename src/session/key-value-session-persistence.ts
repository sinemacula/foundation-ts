/**
 * Key-value {@link SessionPersistence}: the snapshot is one JSON value, so a
 * single storage write replaces the whole session.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { KeyValueStorage } from '../storage/key-value-storage';
import type { KeyValueSessionRecordStoreOptions } from './key-value-session-record-store';
import { KeyValueSessionRecordStore } from './key-value-session-record-store';
import { RecordSessionPersistence } from './record-session-persistence';

/**
 * Options for {@link KeyValueSessionPersistence}.
 */
export type KeyValueSessionPersistenceOptions = KeyValueSessionRecordStoreOptions;

/**
 * Persist the session snapshot in a key-value storage adapter as one JSON
 * value, through a {@link KeyValueSessionRecordStore}.
 *
 * Consistent across contexts only where that store is: every context writing
 * the key shares the lock, and the storage shows each context every write made
 * before it reads. Browser tabs sharing localStorage do not meet this; give
 * them a {@link RecordSessionPersistence} over a transactional store instead.
 * The storage must throw when it cannot read or write: a storage that swallows
 * failures would report a lost write as saved and an unreadable session as
 * none.
 */
export class KeyValueSessionPersistence extends RecordSessionPersistence {
    constructor(storage: KeyValueStorage, options: KeyValueSessionPersistenceOptions = {}) {
        super(new KeyValueSessionRecordStore(storage, options));
    }
}
