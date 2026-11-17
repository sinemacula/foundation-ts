/**
 * KeyValueStorage contract, run against every adapter of the port.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import type { KeyValueStorage } from '../key-value-storage';

/** The adapter-specific hooks the contract is parameterised by. */
export interface KeyValueStorageContractHarness {
    /**
     * Build a storage over a fresh, empty store.
     */
    create(): KeyValueStorage;
}

/**
 * Assert the shared KeyValueStorage contract against one adapter.
 *
 * @param harness - the adapter-specific storage harness
 */
export function describeKeyValueStorageContract(harness: KeyValueStorageContractHarness): void {
    describe('KeyValueStorage contract', () => {
        it('reads an absent key as null', () => {
            expect(harness.create().get('absent')).toBeNull();
        });

        it('keeps an empty string apart from an absent value', () => {
            const storage = harness.create();

            storage.set('key', '');

            expect(storage.get('key')).toBe('');
        });

        it('overwrites a stored value', () => {
            const storage = harness.create();

            storage.set('key', 'first');
            storage.set('key', 'second');

            expect(storage.get('key')).toBe('second');
        });

        it('removes a value, idempotently, and removes an absent key without throwing', () => {
            const storage = harness.create();

            storage.set('key', 'value');
            storage.remove('key');
            storage.remove('key');
            storage.remove('absent');

            expect(storage.get('key')).toBeNull();
        });

        it('keeps keys sharing a prefix, a separator or non-ASCII characters apart', () => {
            const storage = harness.create();
            const keys = ['a', 'a.b', 'a:b', 'é', '🔑'];

            for (const key of keys) {
                storage.set(key, `value of ${key}`);
            }

            storage.remove('a');

            expect(keys.map(key => storage.get(key))).toStrictEqual([
                null,
                'value of a.b',
                'value of a:b',
                'value of é',
                'value of 🔑',
            ]);
        });

        it.each([
            ['unicode', 'héllo wörld 🔑'],
            ['JSON', JSON.stringify({ revision: 1, session: { lineage: 'l', nested: ['a', null, 1.5] } })],
        ])('round-trips a %s value', (_label, value) => {
            const storage = harness.create();

            storage.set('key', value);

            expect(storage.get('key')).toBe(value);
        });
    });
}
