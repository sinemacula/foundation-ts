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
     * Build a store whose backing storage fails every read and write.
     */
    broken(): SessionRecordStore;
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

        it('runs concurrent swaps from every handle one at a time, each deciding on the last', async () => {
            const handles = harness.create();

            await Promise.all(
                Array.from({ length: 5 }, () => handles().swap(current => String(Number(current ?? '0') + 1))),
            );

            await expect(handles().read()).resolves.toBe('5');
        });

        it('rejects a read and a swap when the backing storage fails', async () => {
            const store = harness.broken();

            await expect(store.read()).rejects.toThrow();
            await expect(store.swap(() => 'record')).rejects.toThrow();
        });
    });
}
