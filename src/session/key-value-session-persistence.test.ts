/**
 * Unit tests for the key-value session persistence adapter.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../storage/memory-storage';
import { KeyValueSessionPersistence } from './key-value-session-persistence';
import { SessionError } from './session-error';
import type { SessionLock } from './session-lock';
import type { SessionTokens } from './session-tokens';

/**
 * A lock recording whether a task is running inside it.
 */
class RecordingLock implements SessionLock {
    /** Whether a task is running. */
    held = false;

    /** How many tasks have run. */
    runs = 0;

    /**
     * Run the task, marking the lock held until it settles.
     */
    async run<T>(task: () => Promise<T>): Promise<T> {
        this.held = true;
        this.runs += 1;

        try {
            return await task();
        } finally {
            this.held = false;
        }
    }
}

/**
 * A memory storage recording whether each write happened inside a lock.
 */
class LockCheckingStorage extends MemoryStorage {
    /** Whether the lock was held at each write. */
    readonly writesHeld: boolean[] = [];

    /** The lock the writes are checked against. */
    readonly #lock: RecordingLock;

    constructor(lock: RecordingLock) {
        super();
        this.#lock = lock;
    }

    /**
     * Record whether the lock is held, then store the value.
     */
    override set(key: string, value: string): void {
        this.writesHeld.push(this.#lock.held);
        super.set(key, value);
    }
}

const TOKENS: SessionTokens = { accessToken: 'access', refreshToken: 'refresh', expiresAtEpochMs: 1_700_000_000_000 };

/**
 * Serialise a stored snapshot.
 */
function stored(revision: unknown, tokens: unknown): string {
    return JSON.stringify({ revision, tokens });
}

/**
 * Load from a storage holding the given value under the default key.
 */
function loadStored(value: string): Promise<unknown> {
    const storage = new MemoryStorage();

    storage.set('auth.session', value);

    return new KeyValueSessionPersistence(storage).load();
}

describe('KeyValueSessionPersistence', () => {
    it('loads revision 0 without tokens when nothing is stored', async () => {
        await expect(new KeyValueSessionPersistence(new MemoryStorage()).load()).resolves.toStrictEqual({
            revision: 0,
            tokens: null,
        });
    });

    it('saves at the expected revision as one JSON value under the next revision', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        await expect(persistence.saveIf(0, TOKENS)).resolves.toStrictEqual({ status: 'saved', revision: 1 });
        await expect(persistence.saveIf(1, { ...TOKENS, accessToken: 'next' })).resolves.toStrictEqual({
            status: 'saved',
            revision: 2,
        });

        expect(storage.get('auth.session')).toBe(stored(2, { ...TOKENS, accessToken: 'next' }));
        await expect(persistence.load()).resolves.toStrictEqual({
            revision: 2,
            tokens: { ...TOKENS, accessToken: 'next' },
        });
    });

    it('round-trips null refresh token and expiry', async () => {
        const persistence = new KeyValueSessionPersistence(new MemoryStorage());
        const tokens = { accessToken: 'access', refreshToken: null, expiresAtEpochMs: null };

        await persistence.saveIf(0, tokens);

        await expect(persistence.load()).resolves.toStrictEqual({ revision: 1, tokens });
    });

    it('refuses a save at another revision, reporting the snapshot as it stands', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        await persistence.saveIf(0, TOKENS);

        await expect(persistence.saveIf(0, { ...TOKENS, accessToken: 'late' })).resolves.toStrictEqual({
            status: 'changed',
            current: { revision: 1, tokens: TOKENS },
        });
        expect(storage.get('auth.session')).toBe(stored(1, TOKENS));
    });

    it('clears at the expected revision, keeping the revision growing', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        storage.set('auth.device_uuid', 'device');
        await persistence.saveIf(0, TOKENS);

        await expect(persistence.clearIf(1)).resolves.toStrictEqual({ status: 'cleared', revision: 2 });
        await expect(persistence.load()).resolves.toStrictEqual({ revision: 2, tokens: null });
        expect(storage.get('auth.device_uuid')).toBe('device');
    });

    it('refuses a clear at another revision', async () => {
        const persistence = new KeyValueSessionPersistence(new MemoryStorage());

        await persistence.saveIf(0, TOKENS);

        await expect(persistence.clearIf(0)).resolves.toStrictEqual({
            status: 'changed',
            current: { revision: 1, tokens: TOKENS },
        });
    });

    it('lets one of two writes at the same revision through', async () => {
        const persistence = new KeyValueSessionPersistence(new MemoryStorage());

        const results = await Promise.all([persistence.saveIf(0, TOKENS), persistence.clearIf(0)]);

        expect(results).toStrictEqual([
            { status: 'saved', revision: 1 },
            { status: 'changed', current: { revision: 1, tokens: TOKENS } },
        ]);
    });

    it('writes only while holding the lock', async () => {
        const lock = new RecordingLock();
        const storage = new LockCheckingStorage(lock);
        const persistence = new KeyValueSessionPersistence(storage, { lock });

        await persistence.saveIf(0, TOKENS);
        await persistence.clearIf(1);

        expect(lock.runs).toBe(2);
        expect(storage.writesHeld).toStrictEqual([true, true]);
    });

    it('stores under a custom key', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage, { key: 'app.session' });

        await persistence.saveIf(0, TOKENS);

        expect(storage.get('app.session')).toBe(stored(1, TOKENS));
        expect(storage.get('auth.session')).toBeNull();
        await expect(persistence.load()).resolves.toStrictEqual({ revision: 1, tokens: TOKENS });
    });

    it('rejects when the storage cannot be read', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        storage.get = (): string | null => {
            throw new Error('unavailable');
        };

        await expect(persistence.load()).rejects.toThrow('unavailable');
        await expect(persistence.saveIf(0, TOKENS)).rejects.toThrow('unavailable');
        await expect(persistence.clearIf(0)).rejects.toThrow('unavailable');
    });

    it('rejects when the storage cannot be written', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        storage.set = (): void => {
            throw new Error('quota');
        };

        await expect(persistence.saveIf(0, TOKENS)).rejects.toThrow('quota');
        await expect(persistence.clearIf(0)).rejects.toThrow('quota');
    });

    it('rejects a value that is not JSON, keeping the parse failure as the cause', async () => {
        const error: unknown = await loadStored('{').catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(SessionError);
        expect(error).toHaveProperty('message', 'The persisted session could not be read.');
        expect(error).toHaveProperty('cause', expect.any(SyntaxError));
    });

    it.each([
        ['not JSON', '{'],
        ['not a snapshot', stored(0, null)],
    ])('saves over a stored value that is %s as an empty store at revision 0', async (_label, value) => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        storage.set('auth.session', value);

        await expect(persistence.saveIf(0, TOKENS)).resolves.toStrictEqual({ status: 'saved', revision: 1 });
        expect(storage.get('auth.session')).toBe(stored(1, TOKENS));
    });

    it('clears over a stored value that is not a snapshot as an empty store at revision 0', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        storage.set('auth.session', '{');

        await expect(persistence.clearIf(0)).resolves.toStrictEqual({ status: 'cleared', revision: 1 });
        await expect(persistence.load()).resolves.toStrictEqual({ revision: 1, tokens: null });
    });

    it('refuses a write at a later revision over a stored value that is not a snapshot', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        storage.set('auth.session', '{');

        await expect(persistence.saveIf(3, TOKENS)).resolves.toStrictEqual({
            status: 'changed',
            current: { revision: 0, tokens: null },
        });
        await expect(persistence.clearIf(3)).resolves.toStrictEqual({
            status: 'changed',
            current: { revision: 0, tokens: null },
        });
        expect(storage.get('auth.session')).toBe('{');
    });

    it.each([
        ['a non-record', '"session"'],
        ['null', 'null'],
        ['a missing revision', JSON.stringify({ tokens: null })],
        ['a zero revision', stored(0, null)],
        ['a fractional revision', stored(1.5, null)],
        ['a string revision', stored('1', null)],
        ['missing tokens', JSON.stringify({ revision: 1 })],
        ['non-record tokens', stored(1, 'access')],
        ['a missing access token', stored(1, { refreshToken: null, expiresAtEpochMs: null })],
        ['an empty access token', stored(1, { ...TOKENS, accessToken: '' })],
        ['a non-string access token', stored(1, { ...TOKENS, accessToken: 1 })],
        ['a non-string refresh token', stored(1, { ...TOKENS, refreshToken: 1 })],
        ['a missing refresh token', stored(1, { accessToken: 'access', expiresAtEpochMs: null })],
        ['a string expiry', stored(1, { ...TOKENS, expiresAtEpochMs: '1' })],
        ['a missing expiry', stored(1, { accessToken: 'access', refreshToken: null })],
    ])('rejects a stored snapshot with %s', async (_label, value) => {
        const error: unknown = await loadStored(value).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(SessionError);
        expect(error).toHaveProperty('message', 'The persisted session could not be read.');
        expect(error).not.toHaveProperty('cause');
    });
});
