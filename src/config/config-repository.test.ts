/**
 * Unit tests for config-repository.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { DeepReadonly } from './config-repository';
import { ConfigRepository } from './config-repository';

/** A configuration tree exercising every shape the read-only typing maps. */
interface ShapedConfig {
    /** Nested settings with an array and an optional branch. */
    readonly api: {
        /** Mutable as declared, read-only once frozen. */
        headers: string[];

        /** An optional nested branch. */
        retry?: {
            /** The retry budget. */
            attempts: number;
        };
    };

    /** A fixed-length tuple. */
    readonly pair: [string, number];

    /** A function leaf. */
    readonly format: (value: number) => string;
}

/** The read-only view expected of {@link ShapedConfig.api} once frozen. */
interface FrozenApiSettings {
    /** The headers, as a read-only array. */
    readonly headers: readonly string[];

    /** The optional branch, still optional and read-only. */
    readonly retry?: {
        /** The retry budget. */
        readonly attempts: number;
    };
}

/**
 * Build a fresh configuration tree of every mapped shape.
 */
function createShapedConfig(): ShapedConfig {
    return {
        api: { headers: ['accept'], retry: { attempts: 3 } },
        pair: ['timeout', 30],
        format: value => `#${String(value)}`,
    };
}

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
            expect(Object.isFrozen(all.app)).toBe(true);
        });
    });

    describe('typing', () => {
        it('types the tree as deeply read-only, keeping optional branches and function signatures', () => {
            const all = new ConfigRepository(createShapedConfig()).all();

            expectTypeOf(all).toEqualTypeOf<DeepReadonly<ShapedConfig>>();
            expectTypeOf(all.api).toEqualTypeOf<FrozenApiSettings>();
            expectTypeOf(all.pair).toEqualTypeOf<readonly [string, number]>();
            expectTypeOf(all.format).toEqualTypeOf<(value: number) => string>();
        });

        it('rejects mutation of nested values at compile time', () => {
            const all = new ConfigRepository(createShapedConfig()).all();

            expectTypeOf(() => {
                // @ts-expect-error nested arrays are read-only
                all.api.headers.push('x-trace');
            }).toBeFunction();
            expectTypeOf(() => {
                // @ts-expect-error nested properties are read-only
                all.api.headers = [];
            }).toBeFunction();
            expectTypeOf(() => {
                // @ts-expect-error tuple elements are read-only
                all.pair[1] = 60;
            }).toBeFunction();
        });

        it('accepts a configuration declared as an interface', () => {
            expectTypeOf(new ConfigRepository<ShapedConfig>(createShapedConfig())).toEqualTypeOf<
                ConfigRepository<ShapedConfig>
            >();
        });
    });

    describe('freezing', () => {
        it('freezes the supplied object in place and holds that reference', () => {
            const values = { app: { name: 'MyApp' } };
            const config = new ConfigRepository(values);

            expect(config.all()).toBe(values);
            expect(Object.isFrozen(values)).toBe(true);
            expect(Object.isFrozen(values.app)).toBe(true);
        });

        it('fully freezes a frozen root whose children are mutable', () => {
            const app = { urls: { api: 'https://api.example.com' } };
            const config = new ConfigRepository(Object.freeze({ app }));

            expect(Object.isFrozen(config.all())).toBe(true);
            expect(Object.isFrozen(app)).toBe(true);
            expect(Object.isFrozen(app.urls)).toBe(true);
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

        it('returns undefined for a missing path without a fallback', () => {
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

        it.each(['app.name.sub', 'app.name.length'])('returns the fallback when %s descends into a primitive', path => {
            const config = new ConfigRepository({ app: { name: 'string' } });

            expect(config.get(path, 'fallback')).toBe('fallback');
        });

        it('returns the fallback when the root-level segment is missing', () => {
            const config = new ConfigRepository({});

            expect(config.get('missing', 'fallback')).toBe('fallback');
        });

        it('returns a nested object at a partial path', () => {
            const config = new ConfigRepository({ app: { urls: { api: 'https://api.example.com' } } });

            expect(config.get('app.urls')).toStrictEqual({ api: 'https://api.example.com' });
        });

        it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty', 'app.toString', 'app.constructor'])(
            'falls back for the inherited member %s',
            path => {
                const config = new ConfigRepository({ app: { name: 'MyApp' } });

                expect(config.get(path, 'fallback')).toBe('fallback');
                expect(config.has(path)).toBe(false);
            },
        );

        it.each([
            ['an array index', 'locales.1', 'fr-FR'],
            ['an array length', 'locales.length', 2],
        ])('resolves %s as an own property', (_, path, expected) => {
            const config = new ConfigRepository({ locales: ['en-GB', 'fr-FR'] });

            expect(config.get(path)).toBe(expected);
        });

        it('resolves an own __proto__ key parsed from JSON', () => {
            const config = new ConfigRepository(JSON.parse('{"__proto__":{"a":1}}') as Record<string, unknown>);

            expect(config.get('__proto__.a')).toBe(1);
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
        it('freezes nested objects', () => {
            const config = new ConfigRepository({ nested: { value: 42 } });
            const all = config.all();

            expect(Object.isFrozen(all.nested)).toBe(true);
        });

        it('freezes nested arrays', () => {
            const config = new ConfigRepository({ items: [1, 2, 3] });
            const all = config.all();

            expect(Object.isFrozen(all.items)).toBe(true);
        });
    });
});
