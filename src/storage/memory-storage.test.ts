/**
 * Unit tests for memory-storage.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { MemoryStorage } from './memory-storage';

describe('MemoryStorage', () => {
    it('returns null for a key that has not been set', () => {
        const storage = new MemoryStorage();

        expect(storage.get('missing')).toBeNull();
    });

    it('returns the stored value after set', () => {
        const storage = new MemoryStorage();

        storage.set('key', 'value');

        expect(storage.get('key')).toBe('value');
    });

    it('overwrites an existing value on set', () => {
        const storage = new MemoryStorage();

        storage.set('key', 'first');
        storage.set('key', 'second');

        expect(storage.get('key')).toBe('second');
    });

    it('returns null after the key is removed', () => {
        const storage = new MemoryStorage();

        storage.set('key', 'value');
        storage.remove('key');

        expect(storage.get('key')).toBeNull();
    });

    it('does not throw when removing a key that does not exist', () => {
        const storage = new MemoryStorage();

        expect(() => storage.remove('nonexistent')).not.toThrow();
    });

    it('stores multiple keys independently', () => {
        const storage = new MemoryStorage();

        storage.set('a', '1');
        storage.set('b', '2');

        expect(storage.get('a')).toBe('1');
        expect(storage.get('b')).toBe('2');
    });

    it('removing one key does not affect another', () => {
        const storage = new MemoryStorage();

        storage.set('a', '1');
        storage.set('b', '2');
        storage.remove('a');

        expect(storage.get('b')).toBe('2');
    });
});
