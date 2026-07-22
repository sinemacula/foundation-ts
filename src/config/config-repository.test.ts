/**
 * Unit tests for config-repository.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { ConfigRepository } from './config-repository';

describe('ConfigRepository', () => {
    describe('all', () => {
        it('returns the full configuration tree', () => {
            const config = new ConfigRepository({ app: { name: 'MyApp' } });

            expect(config.all()).toStrictEqual({ app: { name: 'MyApp' } });
        });

        it('returns a deeply frozen object', () => {
            const config = new ConfigRepository({ app: { urls: { api: 'https://api.example.com' } } });
            const all = config.all();

            expect(Object.isFrozen(all)).toBe(true);
            expect(Object.isFrozen((all as Record<string, unknown>)['app'])).toBe(true);
        });
    });

    describe('get', () => {
        it('returns the value at a shallow path', () => {
            const config = new ConfigRepository({ name: 'MyApp' });

            expect(config.get('name')).toBe('MyApp');
        });

        it('returns the value at a deep dot-notation path', () => {
            const config = new ConfigRepository({ app: { urls: { api: 'https://api.example.com' } } });

            expect(config.get('app.urls.api')).toBe('https://api.example.com');
        });

        it('returns undefined for a path that does not exist when no fallback is provided', () => {
            const config = new ConfigRepository({ app: { name: 'x' } });

            expect(config.get('app.missing')).toBeUndefined();
        });

        it('returns the fallback when the path does not resolve', () => {
            const config = new ConfigRepository({ app: {} });

            expect(config.get('app.missing', 'default')).toBe('default');
        });

        it('returns the fallback when traversal hits null', () => {
            const config = new ConfigRepository({ app: { urls: null } });

            expect(config.get('app.urls.api', 'fallback')).toBe('fallback');
        });

        it('returns the fallback when traversal hits a primitive mid-path', () => {
            const config = new ConfigRepository({ app: { name: 'string' } });

            expect(config.get('app.name.sub', 'fallback')).toBe('fallback');
        });

        it('returns the fallback when the root-level segment is missing', () => {
            const config = new ConfigRepository({});

            expect(config.get('missing', 'fallback')).toBe('fallback');
        });

        it('returns a nested object at a partial path', () => {
            const config = new ConfigRepository({ app: { urls: { api: 'https://api.example.com' } } });

            expect(config.get('app.urls')).toStrictEqual({ api: 'https://api.example.com' });
        });
    });

    describe('has', () => {
        it('returns true when the path resolves to a value', () => {
            const config = new ConfigRepository({ app: { name: 'MyApp' } });

            expect(config.has('app.name')).toBe(true);
        });

        it('returns false when the path does not resolve', () => {
            const config = new ConfigRepository({ app: {} });

            expect(config.has('app.missing')).toBe(false);
        });

        it('returns true for a shallow path', () => {
            const config = new ConfigRepository({ key: 'value' });

            expect(config.has('key')).toBe(true);
        });

        it('returns false for an entirely absent root key', () => {
            const config = new ConfigRepository({});

            expect(config.has('absent')).toBe(false);
        });
    });

    describe('deep immutability', () => {
        it('deeply freezes nested objects so mutations are silently ignored in non-strict contexts', () => {
            const config = new ConfigRepository({ nested: { value: 42 } });
            const all = config.all() as { nested: { value: number } };

            expect(Object.isFrozen(all.nested)).toBe(true);
        });

        it('deeply freezes array values inside the configuration', () => {
            const config = new ConfigRepository({ items: [1, 2, 3] });
            const all = config.all() as { items: number[] };

            expect(Object.isFrozen(all.items)).toBe(true);
        });
    });
});
