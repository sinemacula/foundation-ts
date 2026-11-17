/**
 * SessionRecordStore contract, run against every adapter of the port.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import type { SessionRecordStore } from '../session-record-store';

/** The adapter-specific hooks the contract is parameterised by. */
export interface SessionRecordStoreContractHarness {
    /**
     * Start a fresh, empty store.
     *
     * @returns a factory of handles on that one store, as separate contexts
     * sharing it would hold
     */
    create(): () => SessionRecordStore;

    /**
     * Start a store holding the record, whose every swap fails to store what it
     * decided.
     *
     * @returns a factory of handles on that one store
     */
    failing(record: string): () => SessionRecordStore;

    /**
     * Build a store whose backing storage fails every read and write.
     */
    broken(): SessionRecordStore;
}

/**
 * Let pending callbacks run, giving a store the chance to call back late.
 */
async function drain(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) {
        await new Promise<void>(resolve => {
            setTimeout(resolve, 0);
        });
    }
}

/**
 * Swap in a record, whatever is stored.
 */
function put(store: SessionRecordStore, record: string): Promise<void> {
    return store.swap(() => record);
}

/**
 * Assert the shared SessionRecordStore contract against one adapter.
 *
 * @param harness - the adapter-specific store harness
 */
export function describeSessionRecordStoreContract(harness: SessionRecordStoreContractHarness): void {
    describe('SessionRecordStore contract', () => {
        it('reads null from a fresh store', async () => {
            await expect(harness.create()().read()).resolves.toBeNull();
        });

        it('decides once on what is stored, then stores what it decided', async () => {
            const store = harness.create()();
            const seen: Array<string | null> = [];

            await store.swap(current => {
                seen.push(current);

                return 'first';
            });
            await store.swap(current => {
                seen.push(current);

                return 'second';
            });

            await drain();

            expect(seen).toStrictEqual([null, 'first']);
            await expect(store.read()).resolves.toBe('second');
        });

        it.each([
            ['an empty store', null],
            ['a stored record', 'kept'],
        ])('leaves %s alone when the decision is null', async (_label, record) => {
            const store = harness.create()();

            if (record !== null) {
                await put(store, record);
            }

            await store.swap(() => null);

            await expect(store.read()).resolves.toBe(record);
        });

        it('shows every handle what another stored, to a read and to a swap', async () => {
            const handles = harness.create();
            const writer = handles();
            const reader = handles();
            let seen: string | null = null;

            await put(writer, 'record');

            await expect(reader.read()).resolves.toBe('record');
            await reader.swap(current => {
                seen = current;

                return null;
            });
            expect(seen).toBe('record');
        });

        it('runs concurrent swaps from every handle one at a time, each deciding once on the last', async () => {
            const handles = harness.create();
            const decisions = [0, 0, 0, 0, 0];

            await Promise.all(
                decisions.map((_count, index) =>
                    handles().swap(current => {
                        decisions[index] = (decisions[index] ?? 0) + 1;

                        return String(Number(current ?? '0') + 1);
                    }),
                ),
            );
            await drain();

            expect(decisions).toStrictEqual([1, 1, 1, 1, 1]);
            await expect(handles().read()).resolves.toBe('5');
        });

        it('rejects a swap that fails to store, leaving the record every handle sees as it was', async () => {
            const handles = harness.failing('kept');
            const writer = handles();
            const reader = handles();

            const [swapped, read] = await Promise.allSettled([writer.swap(() => 'replaced'), reader.read()]);

            expect(swapped.status).toBe('rejected');
            expect(read).toStrictEqual({ status: 'fulfilled', value: 'kept' });
            await expect(reader.read()).resolves.toBe('kept');
            await expect(writer.read()).resolves.toBe('kept');
        });

        it('rejects a read and a swap when the backing storage fails', async () => {
            const store = harness.broken();

            await expect(store.read()).rejects.toThrow();
            await expect(store.swap(() => 'record')).rejects.toThrow();
        });
    });
}
