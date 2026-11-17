/**
 * SessionPersistence contract, run against every adapter of the port.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import type {
    PersistedSession,
    SessionClearResult,
    SessionPersistence,
    SessionSaveResult,
    SessionVersion,
} from '../session-persistence';

/** The adapter-specific hooks the contract is parameterised by. */
export interface SessionPersistenceContractHarness {
    /**
     * Start a fresh, empty store.
     *
     * @returns a factory of handles on that one store, as separate contexts
     * sharing it would hold
     */
    create(): () => SessionPersistence;

    /**
     * Build a persistence whose backing store fails every read and write.
     */
    broken(): SessionPersistence;
}

const EMPTY: SessionVersion = { revision: 0, lineage: null };

/**
 * Build a persisted session.
 */
function session(lineage: string, accessToken: string): PersistedSession {
    return { lineage, tokens: { accessToken, refreshToken: `refresh-${accessToken}`, expiresAtEpochMs: 1_000 } };
}

/**
 * Read the revision a write produced.
 *
 * @throws when the write was refused
 */
function written(result: SessionSaveResult | SessionClearResult): number {
    if (result.status === 'changed') {
        return expect.unreachable('Expected the write to be made.');
    }

    return result.revision;
}

/**
 * Assert the shared SessionPersistence contract against one adapter.
 *
 * @param harness - the adapter-specific store harness
 */
export function describeSessionPersistenceContract(harness: SessionPersistenceContractHarness): void {
    describe('SessionPersistence contract', () => {
        it('loads revision 0 with no session from a fresh store', async () => {
            await expect(harness.create()().load()).resolves.toStrictEqual({ revision: 0, session: null });
        });

        it('saves at the current version under a higher revision, loading what it saved', async () => {
            const persistence = harness.create()();
            const saved = session('lineage', 'a');

            const result = await persistence.saveIf(EMPTY, saved);

            expect(result.status).toBe('saved');
            expect(written(result)).toBeGreaterThan(0);
            await expect(persistence.load()).resolves.toStrictEqual({ revision: written(result), session: saved });
        });

        it('round-trips a null refresh token and expiry', async () => {
            const persistence = harness.create()();
            const saved = {
                lineage: 'lineage',
                tokens: { accessToken: 'a', refreshToken: null, expiresAtEpochMs: null },
            };

            const revision = written(await persistence.saveIf(EMPTY, saved));

            await expect(persistence.load()).resolves.toStrictEqual({ revision, session: saved });
        });

        it.each([
            [
                'a stale revision',
                (revision: number): SessionVersion => ({ revision: revision - 1, lineage: 'lineage' }),
            ],
            ['another lineage', (revision: number): SessionVersion => ({ revision, lineage: 'other' })],
            ['no lineage', (revision: number): SessionVersion => ({ revision, lineage: null })],
        ])('refuses writes expecting %s, reporting the snapshot and writing nothing', async (_label, version) => {
            const persistence = harness.create()();
            const saved = session('lineage', 'a');
            const revision = written(await persistence.saveIf(EMPTY, saved));
            const current = { revision, session: saved };

            await expect(persistence.saveIf(version(revision), session('lineage', 'b'))).resolves.toStrictEqual({
                status: 'changed',
                current,
            });
            await expect(persistence.clearIf(version(revision))).resolves.toStrictEqual({ status: 'changed', current });
            await expect(persistence.load()).resolves.toStrictEqual(current);
        });

        it('refuses a write expecting a session on an empty store', async () => {
            const persistence = harness.create()();

            await expect(
                persistence.saveIf({ revision: 0, lineage: 'lineage' }, session('lineage', 'a')),
            ).resolves.toStrictEqual({
                status: 'changed',
                current: { revision: 0, session: null },
            });
        });

        it('grows the revision with every write, clearing included', async () => {
            const persistence = harness.create()();
            const first = written(await persistence.saveIf(EMPTY, session('lineage', 'a')));
            const second = written(
                await persistence.saveIf({ revision: first, lineage: 'lineage' }, session('lineage', 'b')),
            );
            const cleared = await persistence.clearIf({ revision: second, lineage: 'lineage' });
            const third = written(cleared);
            const fourth = written(await persistence.saveIf({ revision: third, lineage: null }, session('next', 'c')));

            expect(cleared.status).toBe('cleared');
            expect(second).toBeGreaterThan(first);
            expect(third).toBeGreaterThan(second);
            expect(fourth).toBeGreaterThan(third);
            await expect(persistence.load()).resolves.toStrictEqual({
                revision: fourth,
                session: session('next', 'c'),
            });
        });

        it('loads on one handle what another wrote', async () => {
            const handles = harness.create();
            const writer = handles();
            const reader = handles();
            const revision = written(await writer.saveIf(EMPTY, session('lineage', 'a')));

            await expect(reader.load()).resolves.toStrictEqual({ revision, session: session('lineage', 'a') });

            const cleared = written(await reader.clearIf({ revision, lineage: 'lineage' }));

            await expect(writer.load()).resolves.toStrictEqual({ revision: cleared, session: null });
        });

        it('lets exactly one of two concurrent writes at one version through', async () => {
            const handles = harness.create();
            const results = await Promise.all([
                handles().saveIf(EMPTY, session('first', 'a')),
                handles().saveIf(EMPTY, session('second', 'b')),
            ]);
            const winner = results.findIndex(result => result.status === 'saved');
            const loser = results[1 - winner];
            const snapshot = await handles().load();

            expect(results.map(result => result.status).sort()).toStrictEqual(['changed', 'saved']);
            expect(loser).toStrictEqual({ status: 'changed', current: snapshot });
            expect(snapshot.session?.lineage).toBe(winner === 0 ? 'first' : 'second');
        });

        it('rejects every operation when the backing store fails', async () => {
            const persistence = harness.broken();

            await expect(persistence.load()).rejects.toThrow();
            await expect(persistence.saveIf(EMPTY, session('lineage', 'a'))).rejects.toThrow();
            await expect(persistence.clearIf(EMPTY)).rejects.toThrow();
        });
    });
}
