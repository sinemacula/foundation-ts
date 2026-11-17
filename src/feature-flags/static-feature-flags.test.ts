/**
 * Unit tests for StaticFeatureFlags.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { FeatureFlags, FlagValue } from './feature-flags';
import { StaticFeatureFlags } from './static-feature-flags';
import { describeFeatureFlagsContract } from './test-support/feature-flags-contract';

describe('StaticFeatureFlags', () => {
    describeFeatureFlagsContract({
        create(initial) {
            const flags = new StaticFeatureFlags(initial);

            return { flags, change: next => flags.replace(next) };
        },
    });

    describe('constructor', () => {
        it('defaults to an empty flag set', () => {
            const flags = new StaticFeatureFlags();

            expect(flags.isEnabled('missing')).toBe(false);
        });

        it('accepts an initial flag record', () => {
            const flags = new StaticFeatureFlags({ 'my-flag': true });

            expect(flags.isEnabled('my-flag')).toBe(true);
        });
    });

    describe('variant types', () => {
        const flags = new StaticFeatureFlags({ flag: 'a' });
        const port: FeatureFlags = flags;
        const mixed = 'a' as 0 | 'a';

        it('widens a literal fallback to its primitive type', () => {
            expectTypeOf(port.variant('flag', 'a')).toEqualTypeOf<string>();
            expectTypeOf(port.variant('flag', 1)).toEqualTypeOf<number>();
            expectTypeOf(port.variant('flag', true)).toEqualTypeOf<boolean>();
            expectTypeOf(flags.variant('flag', 'a')).toEqualTypeOf<string>();
            expectTypeOf(flags.variant('flag', 1)).toEqualTypeOf<number>();
            expectTypeOf(flags.variant('flag', true)).toEqualTypeOf<boolean>();
        });

        it('compares a resolved variant with any other literal', () => {
            expect(port.variant('flag', 'b') === 'a').toBe(true);
            expect(flags.variant('flag', 'b') === 'c').toBe(false);
        });

        it('widens a mixed fallback to FlagValue', () => {
            const anyValue = 0 as FlagValue;

            expectTypeOf(port.variant('flag', mixed)).toEqualTypeOf<FlagValue>();
            expectTypeOf(port.variant('flag', anyValue)).toEqualTypeOf<FlagValue>();
            expectTypeOf(flags.variant('flag', mixed)).toEqualTypeOf<FlagValue>();
            expectTypeOf(flags.variant('flag', anyValue)).toEqualTypeOf<FlagValue>();
        });

        it('does not narrow a mixed fallback from the assignment target', () => {
            // @ts-expect-error a mixed fallback resolves to FlagValue
            const fromPort: 0 | 'a' = port.variant('flag', mixed);
            // @ts-expect-error a mixed fallback resolves to FlagValue
            const fromAdapter: 0 | 'a' = flags.variant('flag', mixed);

            expect([fromPort, fromAdapter]).toStrictEqual(['a', 'a']);
        });

        it('narrows to an explicit type argument', () => {
            expectTypeOf(port.variant<'a' | 'b'>('flag', 'b')).toEqualTypeOf<'a' | 'b'>();
            expectTypeOf(flags.variant<'a' | 'b'>('flag', 'b')).toEqualTypeOf<'a' | 'b'>();
            expect(port.variant<'a' | 'b'>('flag', 'b')).toBe('a');
        });

        it('rejects a fallback outside an explicit type argument', () => {
            // @ts-expect-error 'c' is not one of the declared variants
            expect(port.variant<'a' | 'b'>('missing', 'c')).toBe('c');
            // @ts-expect-error 'c' is not one of the declared variants
            expect(flags.variant<'a' | 'b'>('missing', 'c')).toBe('c');
        });
    });

    describe('setContext', () => {
        it('exposes the stored context', () => {
            const flags = new StaticFeatureFlags();
            const ctx = { userId: 'u1', plan: 'pro', beta: true };

            flags.setContext(ctx);

            expect(flags.context).toEqual(ctx);
        });

        it('replaces a stored context', () => {
            const flags = new StaticFeatureFlags();

            flags.setContext({ userId: 'u1' });
            flags.setContext({ userId: 'u2' });

            expect(flags.context).toEqual({ userId: 'u2' });
        });
    });

    describe('throwing handlers', () => {
        it('reports the error and still runs later handlers against the new flags', () => {
            const error = new Error('handler failed');
            const onError = vi.fn();
            const flags = new StaticFeatureFlags({ feat: false }, { onError });
            const seen: boolean[] = [];

            flags.onChange(() => {
                throw error;
            });
            flags.onChange(() => seen.push(flags.isEnabled('feat')));

            expect(() => flags.replace({ feat: true })).not.toThrow();
            expect(seen).toStrictEqual([true]);
            expect(flags.isEnabled('feat')).toBe(true);
            expect(onError).toHaveBeenCalledExactlyOnceWith(error);
        });

        it.each([
            ['no sink', {}],
            [
                'a throwing sink',
                {
                    onError: () => {
                        throw new Error('sink failed');
                    },
                },
            ],
        ])('contains the failure with %s', (_, options) => {
            const flags = new StaticFeatureFlags({}, options);
            const handler = vi.fn();

            flags.onChange(() => {
                throw new Error('handler failed');
            });
            flags.onChange(handler);

            expect(() => flags.replace({ feat: true })).not.toThrow();
            expect(handler).toHaveBeenCalledOnce();
        });
    });

    describe('replace', () => {
        it('swaps the flag set', () => {
            const flags = new StaticFeatureFlags({ feat: false });

            flags.replace({ feat: true });

            expect(flags.isEnabled('feat')).toBe(true);
        });

        it('notifies handlers synchronously in subscription order', () => {
            const flags = new StaticFeatureFlags();
            const calls: string[] = [];

            flags.onChange(() => calls.push('a'));
            flags.onChange(() => calls.push('b'));
            flags.replace({});

            expect(calls).toEqual(['a', 'b']);
        });

        it('lets the rest of a delivery read flags replaced from inside a handler, then notifies again', () => {
            const flags = new StaticFeatureFlags({ step: 0 });
            const seen: string[] = [];
            let replaced = false;

            flags.onChange(() => {
                seen.push(`a:${String(flags.variant('step', 0))}`);

                if (!replaced) {
                    replaced = true;
                    flags.replace({ step: 2 });
                }
            });
            flags.onChange(() => {
                seen.push(`b:${String(flags.variant('step', 0))}`);
            });
            flags.replace({ step: 1 });

            expect(seen).toStrictEqual(['a:1', 'b:2', 'a:2', 'b:2']);
        });
    });
});
