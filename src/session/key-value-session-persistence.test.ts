/**
 * Unit tests for the key-value session persistence adapter.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../storage/memory-storage';
import { InProcessSessionLock } from './in-process-session-lock';
import { KeyValueSessionPersistence } from './key-value-session-persistence';
import { SessionError } from './session-error';
import type { SessionLock } from './session-lock';
import type { PersistedSession } from './session-persistence';
import type { SessionTokens } from './session-tokens';
import { describeSessionPersistenceContract } from './test-support/session-persistence-contract';

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
const SESSION: PersistedSession = { lineage: 'lineage', tokens: TOKENS };
const EMPTY = { revision: 0, lineage: null };

/**
 * Serialise a stored snapshot.
 */
function stored(revision: unknown, session: unknown): string {
    return JSON.stringify({ revision, session });
}

/**
 * Load from a storage holding the given value under the default key.
 */
function loadStored(value: string): Promise<unknown> {
    const storage = new MemoryStorage();

    storage.set('auth.session', value);

    return new KeyValueSessionPersistence(storage).load();
}

/**
 * A storage whose every read and write throws.
 */
function brokenStorage(): MemoryStorage {
    const storage = new MemoryStorage();

    storage.get = (): string | null => {
        throw new Error('unavailable');
    };

    return storage;
}

describeSessionPersistenceContract({
    create: () => {
        const storage = new MemoryStorage();
        const lock = new InProcessSessionLock();

        return () => new KeyValueSessionPersistence(storage, { lock });
    },
    broken: () => new KeyValueSessionPersistence(brokenStorage()),
});

describe('KeyValueSessionPersistence', () => {
    describe('stored format', () => {
        it('loads a stored literal', async () => {
            await expect(
                loadStored(
                    '{"revision":7,"session":{"lineage":"L","tokens":{"accessToken":"a","refreshToken":"r","expiresAtEpochMs":5}}}',
                ),
            ).resolves.toStrictEqual({
                revision: 7,
                session: { lineage: 'L', tokens: { accessToken: 'a', refreshToken: 'r', expiresAtEpochMs: 5 } },
            });
        });

        it('writes exactly this literal on a save to an empty store, whatever the field order handed in', async () => {
            const storage = new MemoryStorage();

            await new KeyValueSessionPersistence(storage).saveIf(EMPTY, {
                tokens: { expiresAtEpochMs: null, refreshToken: null, accessToken: 'a' },
                lineage: 'L',
            });

            expect(storage.get('auth.session')).toBe(
                '{"revision":1,"session":{"lineage":"L","tokens":{"accessToken":"a","refreshToken":null,"expiresAtEpochMs":null}}}',
            );
        });

        it('writes exactly this literal on a clear', async () => {
            const storage = new MemoryStorage();
            const persistence = new KeyValueSessionPersistence(storage);

            await persistence.saveIf(EMPTY, SESSION);
            await persistence.clearIf({ revision: 1, lineage: 'lineage' });

            expect(storage.get('auth.session')).toBe('{"revision":2,"session":null}');
        });
    });

    it('stores one JSON value under the default key, leaving other keys alone', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        storage.set('auth.device_uuid', 'device');
        await persistence.saveIf(EMPTY, SESSION);
        await persistence.clearIf({ revision: 1, lineage: 'lineage' });

        expect(storage.get('auth.session')).toBe(stored(2, null));
        expect(storage.get('auth.device_uuid')).toBe('device');
    });

    it('writes only while holding the lock', async () => {
        const lock = new RecordingLock();
        const storage = new LockCheckingStorage(lock);
        const persistence = new KeyValueSessionPersistence(storage, { lock });

        await persistence.saveIf(EMPTY, SESSION);
        await persistence.clearIf({ revision: 1, lineage: 'lineage' });

        expect(lock.runs).toBe(2);
        expect(storage.writesHeld).toStrictEqual([true, true]);
    });

    it('stores under a custom key', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage, { key: 'app.session' });

        await persistence.saveIf(EMPTY, SESSION);

        expect(storage.get('app.session')).toBe(stored(1, SESSION));
        expect(storage.get('auth.session')).toBeNull();
        await expect(persistence.load()).resolves.toStrictEqual({ revision: 1, session: SESSION });
    });

    it('rejects when the storage cannot be written', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        storage.set = (): void => {
            throw new Error('quota');
        };

        await expect(persistence.saveIf(EMPTY, SESSION)).rejects.toThrow('quota');
        await expect(persistence.clearIf(EMPTY)).rejects.toThrow('quota');
    });

    it('rejects a write once the revision can grow no further, leaving the store alone', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);
        const last = stored(Number.MAX_SAFE_INTEGER, null);
        const expected = { revision: Number.MAX_SAFE_INTEGER, lineage: null };

        storage.set('auth.session', last);

        const errors = await Promise.all([
            persistence.saveIf(expected, SESSION).catch((caught: unknown) => caught),
            persistence.clearIf(expected).catch((caught: unknown) => caught),
        ]);

        for (const error of errors) {
            expect(error).toBeInstanceOf(SessionError);
            expect(error).toHaveProperty('message', 'The persisted session revision cannot grow any further.');
        }

        expect(storage.get('auth.session')).toBe(last);
    });

    it('writes at the last safe revision', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        storage.set('auth.session', stored(Number.MAX_SAFE_INTEGER - 1, null));

        await expect(
            persistence.clearIf({ revision: Number.MAX_SAFE_INTEGER - 1, lineage: null }),
        ).resolves.toStrictEqual({ status: 'cleared', revision: Number.MAX_SAFE_INTEGER });
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
        ['in the format without a lineage', JSON.stringify({ revision: 1, tokens: TOKENS })],
    ])('saves over a stored value that is %s as an empty store at revision 0', async (_label, value) => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        storage.set('auth.session', value);

        await expect(persistence.saveIf(EMPTY, SESSION)).resolves.toStrictEqual({ status: 'saved', revision: 1 });
        expect(storage.get('auth.session')).toBe(stored(1, SESSION));
    });

    it('clears over a stored value that is not a snapshot as an empty store at revision 0', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);

        storage.set('auth.session', '{');

        await expect(persistence.clearIf(EMPTY)).resolves.toStrictEqual({ status: 'cleared', revision: 1 });
        await expect(persistence.load()).resolves.toStrictEqual({ revision: 1, session: null });
    });

    it('refuses a write at a later revision over a stored value that is not a snapshot', async () => {
        const storage = new MemoryStorage();
        const persistence = new KeyValueSessionPersistence(storage);
        const expected = { revision: 3, lineage: null };

        storage.set('auth.session', '{');

        await expect(persistence.saveIf(expected, SESSION)).resolves.toStrictEqual({
            status: 'changed',
            current: { revision: 0, session: null },
        });
        await expect(persistence.clearIf(expected)).resolves.toStrictEqual({
            status: 'changed',
            current: { revision: 0, session: null },
        });
        expect(storage.get('auth.session')).toBe('{');
    });

    it.each([
        ['a non-record', '"session"'],
        ['null', 'null'],
        ['a missing revision', JSON.stringify({ session: null })],
        ['a zero revision', stored(0, null)],
        ['a fractional revision', stored(1.5, null)],
        ['a string revision', stored('1', null)],
        ['an unsafe revision', stored(Number.MAX_SAFE_INTEGER + 1, null)],
        ['a missing session', JSON.stringify({ revision: 1 })],
        ['the format without a lineage', JSON.stringify({ revision: 1, tokens: TOKENS })],
        ['a non-record session', stored(1, 'access')],
        ['a missing lineage', stored(1, { tokens: TOKENS })],
        ['an empty lineage', stored(1, { lineage: '', tokens: TOKENS })],
        ['a non-string lineage', stored(1, { lineage: 1, tokens: TOKENS })],
        ['missing tokens', stored(1, { lineage: 'lineage' })],
        ['non-record tokens', stored(1, { lineage: 'lineage', tokens: 'access' })],
        ['a missing access token', stored(1, { lineage: 'l', tokens: { refreshToken: null, expiresAtEpochMs: null } })],
        ['an empty access token', stored(1, { lineage: 'l', tokens: { ...TOKENS, accessToken: '' } })],
        ['a non-string access token', stored(1, { lineage: 'l', tokens: { ...TOKENS, accessToken: 1 } })],
        ['a non-string refresh token', stored(1, { lineage: 'l', tokens: { ...TOKENS, refreshToken: 1 } })],
        ['a missing refresh token', stored(1, { lineage: 'l', tokens: { accessToken: 'a', expiresAtEpochMs: null } })],
        ['a string expiry', stored(1, { lineage: 'l', tokens: { ...TOKENS, expiresAtEpochMs: '1' } })],
        ['a missing expiry', stored(1, { lineage: 'l', tokens: { accessToken: 'a', refreshToken: null } })],
    ])('rejects a stored snapshot with %s', async (_label, value) => {
        const error: unknown = await loadStored(value).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(SessionError);
        expect(error).toHaveProperty('message', 'The persisted session could not be read.');
        expect(error).not.toHaveProperty('cause');
    });
});
