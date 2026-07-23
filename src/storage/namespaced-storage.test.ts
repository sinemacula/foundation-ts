/**
 * Unit tests for namespaced-storage.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { MemoryStorage } from './memory-storage';
import { NamespacedStorage } from './namespaced-storage';

describe('NamespacedStorage', () => {
    describe('set', () => {
        it('stores the value under the inner storage using the composed key', () => {
            const inner = new MemoryStorage();
            const storage = new NamespacedStorage(inner, 'app');

            storage.set('token', 'abc');

            expect(inner.get('app.token')).toBe('abc');
        });
    });

    describe('get', () => {
        it('resolves a value written through the namespace', () => {
            const inner = new MemoryStorage();
            const storage = new NamespacedStorage(inner, 'app');

            storage.set('token', 'abc');

            expect(storage.get('token')).toBe('abc');
        });

        it('returns null for a key that has not been set', () => {
            const storage = new NamespacedStorage(new MemoryStorage(), 'app');

            expect(storage.get('missing')).toBeNull();
        });
    });

    describe('remove', () => {
        it('removes a value written through the namespace', () => {
            const inner = new MemoryStorage();
            const storage = new NamespacedStorage(inner, 'app');

            storage.set('token', 'abc');
            storage.remove('token');

            expect(storage.get('token')).toBeNull();
            expect(inner.get('app.token')).toBeNull();
        });
    });

    it('isolates two namespaces sharing the same inner storage', () => {
        const inner = new MemoryStorage();
        const first = new NamespacedStorage(inner, 'first');
        const second = new NamespacedStorage(inner, 'second');

        first.set('token', 'first-value');
        second.set('token', 'second-value');

        expect(first.get('token')).toBe('first-value');
        expect(second.get('token')).toBe('second-value');

        first.remove('token');

        expect(first.get('token')).toBeNull();
        expect(second.get('token')).toBe('second-value');
    });

    it('composes prefixes when nesting one namespace inside another', () => {
        const inner = new MemoryStorage();
        const outer = new NamespacedStorage(inner, 'outer');
        const nested = new NamespacedStorage(outer, 'inner');

        nested.set('key', 'value');

        expect(inner.get('outer.inner.key')).toBe('value');
        expect(nested.get('key')).toBe('value');
    });
});
