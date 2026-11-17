/**
 * Unit tests for the key-value session record store.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../storage/memory-storage';
import { InProcessSessionLock } from './in-process-session-lock';
import { KeyValueSessionRecordStore } from './key-value-session-record-store';
import { describeSessionRecordStoreContract } from './test-support/session-record-store-contract';

describeSessionRecordStoreContract({
    create: () => {
        const storage = new MemoryStorage();
        const lock = new InProcessSessionLock();

        return () => new KeyValueSessionRecordStore(storage, { lock });
    },
    broken: () => {
        const storage = new MemoryStorage();

        storage.get = (): string | null => {
            throw new Error('unavailable');
        };

        return new KeyValueSessionRecordStore(storage);
    },
});

describe('KeyValueSessionRecordStore', () => {
    it.each([
        ['the default key', undefined, 'auth.session'],
        ['a custom key', 'app.session', 'app.session'],
    ])('keeps the record under %s', async (_label, key, stored) => {
        const storage = new MemoryStorage();
        const store = new KeyValueSessionRecordStore(storage, key === undefined ? {} : { key });

        await store.swap(() => 'record');

        expect(storage.get(stored)).toBe('record');
        await expect(store.read()).resolves.toBe('record');
    });

    it('writes nothing when the decision is null', async () => {
        const storage = new MemoryStorage();
        const writes: string[] = [];

        storage.set = (key: string): void => {
            writes.push(key);
        };

        await new KeyValueSessionRecordStore(storage).swap(() => null);

        expect(writes).toStrictEqual([]);
    });

    it('rejects when the storage cannot be written', async () => {
        const storage = new MemoryStorage();

        storage.set = (): void => {
            throw new Error('quota');
        };

        await expect(new KeyValueSessionRecordStore(storage).swap(() => 'record')).rejects.toThrow('quota');
    });
});
