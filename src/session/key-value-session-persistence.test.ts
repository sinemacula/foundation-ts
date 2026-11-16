/**
 * Unit tests for the key-value session persistence adapter.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../storage/memory-storage';
import { KeyValueSessionPersistence } from './key-value-session-persistence';
import type { SessionStorageKeys } from './session-storage-keys';

/**
 * A memory storage recording every write.
 */
class RecordingStorage extends MemoryStorage {
    /** Every write, in order. */
    readonly writes: string[] = [];

    /**
     * Record and store a value.
     *
     * @param key - the storage key
     * @param value - the value to store
     */
    override set(key: string, value: string): void {
        this.writes.push(`set:${key}=${value}`);
        super.set(key, value);
    }

    /**
     * Record and remove a key.
     *
     * @param key - the storage key
     */
    override remove(key: string): void {
        this.writes.push(`remove:${key}`);
        super.remove(key);
    }
}

const CUSTOM_KEYS: SessionStorageKeys = {
    accessToken: 'app.access',
    refreshToken: 'app.refresh',
    expiresAt: 'app.expires',
    deviceUuid: 'app.device',
};

describe('KeyValueSessionPersistence', () => {
    it('loads null when no access token is stored', async () => {
        const storage = new MemoryStorage();

        storage.set('auth.refresh_token', 'refresh');

        await expect(new KeyValueSessionPersistence(storage).load()).resolves.toBeNull();
    });

    it('round-trips a full snapshot under the default keys', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        await persistence.save({ accessToken: 'access', refreshToken: 'refresh', expiresAtEpochMs: 1_700_000_000_000 });

        expect(storage.get('auth.access_token')).toBe('access');
        expect(storage.get('auth.refresh_token')).toBe('refresh');
        expect(storage.get('auth.expires_at')).toBe('1700000000000');
        await expect(persistence.load()).resolves.toStrictEqual({
            accessToken: 'access',
            refreshToken: 'refresh',
            expiresAtEpochMs: 1_700_000_000_000,
        });
    });

    it('removes the refresh token and expiry keys when they are null', async () => {
        const storage = new RecordingStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        await persistence.save({ accessToken: 'access', refreshToken: null, expiresAtEpochMs: null });

        expect(storage.writes).toStrictEqual([
            'set:auth.access_token=access',
            'remove:auth.refresh_token',
            'remove:auth.expires_at',
        ]);

        expect(storage.get('auth.refresh_token')).toBeNull();
        expect(storage.get('auth.expires_at')).toBeNull();
        await expect(persistence.load()).resolves.toStrictEqual({
            accessToken: 'access',
            refreshToken: null,
            expiresAtEpochMs: null,
        });
    });

    it.each(['2026-12-31 23:59:59', '12a', 'a12', ''])('reads a non-numeric expiry %j as unknown', async (stored) => {
        const storage = new MemoryStorage();

        storage.set('auth.access_token', 'access');
        storage.set('auth.expires_at', stored);

        await expect(new KeyValueSessionPersistence(storage).load()).resolves.toStrictEqual({
            accessToken: 'access',
            refreshToken: null,
            expiresAtEpochMs: null,
        });
    });

    it('clears every snapshot key', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        storage.set('auth.device_uuid', 'device');
        await persistence.save({ accessToken: 'access', refreshToken: 'refresh', expiresAtEpochMs: 1 });
        await persistence.clear();

        expect(storage.get('auth.access_token')).toBeNull();
        expect(storage.get('auth.refresh_token')).toBeNull();
        expect(storage.get('auth.expires_at')).toBeNull();
        expect(storage.get('auth.device_uuid')).toBe('device');
    });

    it('writes under custom keys', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage, CUSTOM_KEYS);

        await persistence.save({ accessToken: 'access', refreshToken: 'refresh', expiresAtEpochMs: 5 });

        expect(storage.get('app.access')).toBe('access');
        expect(storage.get('app.refresh')).toBe('refresh');
        expect(storage.get('app.expires')).toBe('5');
        await expect(persistence.load()).resolves.toStrictEqual({
            accessToken: 'access',
            refreshToken: 'refresh',
            expiresAtEpochMs: 5,
        });

        await persistence.clear();

        expect(storage.get('app.access')).toBeNull();
        expect(storage.get('app.refresh')).toBeNull();
        expect(storage.get('app.expires')).toBeNull();
    });

    it('rejects when the storage adapter throws', async () => {
        const storage = new MemoryStorage();

        storage.get = (): string | null => {
            throw new Error('unavailable');
        };

        await expect(new KeyValueSessionPersistence(storage).load()).rejects.toThrow('unavailable');
    });
});
