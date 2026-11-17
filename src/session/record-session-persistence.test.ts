/**
 * Unit tests for the record session persistence.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../storage/memory-storage';
import { InProcessSessionLock } from './in-process-session-lock';
import { KeyValueSessionRecordStore } from './key-value-session-record-store';
import { RecordSessionPersistence } from './record-session-persistence';
import { SessionError } from './session-error';
import type { PersistedSession } from './session-persistence';
import type { SessionRecordStore } from './session-record-store';
import { describeSessionPersistenceContract } from './test-support/session-persistence-contract';

const SESSION: PersistedSession = {
    lineage: 'lineage',
    tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAtEpochMs: 1_000 },
};
const EMPTY = { revision: 0, lineage: null };

/**
 * A store holding one record, whose swaps decide and then fail.
 */
class AbortingStore implements SessionRecordStore {
    /** The stored record. */
    record: string | null = null;

    /**
     * Read the record.
     */
    read(): Promise<string | null> {
        return Promise.resolve(this.record);
    }

    /**
     * Decide, then abort before storing anything.
     */
    swap(decide: (current: string | null) => string | null): Promise<void> {
        decide(this.record);

        return Promise.reject(new Error('aborted'));
    }
}

describeSessionPersistenceContract({
    create: () => {
        const storage = new MemoryStorage();
        const lock = new InProcessSessionLock();

        return () => new RecordSessionPersistence(new KeyValueSessionRecordStore(storage, { lock }));
    },
    broken: () => {
        const storage = new MemoryStorage();

        storage.get = (): string | null => {
            throw new Error('unavailable');
        };

        return new RecordSessionPersistence(new KeyValueSessionRecordStore(storage));
    },
});

describe('RecordSessionPersistence', () => {
    it.each([
        ['save', (persistence: RecordSessionPersistence) => persistence.saveIf(EMPTY, SESSION)],
        ['clear', (persistence: RecordSessionPersistence) => persistence.clearIf(EMPTY)],
    ])('rejects a %s whose swap fails after deciding, with the store failure', async (_label, write) => {
        const store = new AbortingStore();

        await expect(write(new RecordSessionPersistence(store))).rejects.toThrow('aborted');
        expect(store.record).toBeNull();
    });

    it('rejects a write the store resolved without deciding', async () => {
        const persistence = new RecordSessionPersistence({
            read: () => Promise.resolve(null),
            swap: () => Promise.resolve(),
        });
        const error: unknown = await persistence.saveIf(EMPTY, SESSION).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(SessionError);
        expect(error).toHaveProperty('message', 'The session record store resolved a swap without deciding it.');
    });

    it('rejects a session that cannot be serialised with the serialisation failure, storing nothing', async () => {
        const storage = new MemoryStorage();
        const persistence = new RecordSessionPersistence(new KeyValueSessionRecordStore(storage));
        const unserialisable = { ...SESSION, tokens: { ...SESSION.tokens, expiresAtEpochMs: 1n as unknown as number } };

        await expect(persistence.saveIf(EMPTY, unserialisable)).rejects.toThrow(TypeError);
        expect(storage.get('auth.session')).toBeNull();
    });
});
