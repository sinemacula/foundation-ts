/**
 * Unit tests for StaticFeatureFlags.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import { StaticFeatureFlags } from './static-feature-flags';

describe('StaticFeatureFlags', () => {
    describe('constructor', () => {
        it('accepts no arguments and defaults to an empty flag set', () => {
            const flags = new StaticFeatureFlags();

            expect(flags.isEnabled('missing')).toBe(false);
        });

        it('accepts an initial flag record', () => {
            const flags = new StaticFeatureFlags({ 'my-flag': true });

            expect(flags.isEnabled('my-flag')).toBe(true);
        });
    });

    describe('isEnabled', () => {
        it('returns the stored boolean when the flag is true', () => {
            const flags = new StaticFeatureFlags({ 'feat-a': true });

            expect(flags.isEnabled('feat-a')).toBe(true);
        });

        it('returns the stored boolean when the flag is false', () => {
            const flags = new StaticFeatureFlags({ 'feat-a': false });

            expect(flags.isEnabled('feat-a')).toBe(false);
        });

        it('returns the default fallback (false) when the flag is absent', () => {
            const flags = new StaticFeatureFlags();

            expect(flags.isEnabled('missing')).toBe(false);
        });

        it('returns a custom fallback when the flag is absent', () => {
            const flags = new StaticFeatureFlags();

            expect(flags.isEnabled('missing', true)).toBe(true);
        });

        it('returns the fallback when the stored value is a string, not a boolean', () => {
            const flags = new StaticFeatureFlags({ 'variant-flag': 'blue' });

            expect(flags.isEnabled('variant-flag')).toBe(false);
        });

        it('returns the fallback when the stored value is a number, not a boolean', () => {
            const flags = new StaticFeatureFlags({ 'numeric-flag': 42 });

            expect(flags.isEnabled('numeric-flag', true)).toBe(true);
        });
    });

    describe('variant', () => {
        it('returns the stored string value when the type matches the fallback', () => {
            const flags = new StaticFeatureFlags({ flow: 'checkout-v2' });

            expect(flags.variant('flow', 'checkout-v1')).toBe('checkout-v2');
        });

        it('returns the stored number value when the type matches the fallback', () => {
            const flags = new StaticFeatureFlags({ limit: 100 });

            expect(flags.variant('limit', 0)).toBe(100);
        });

        it('returns the stored boolean value when the type matches the fallback', () => {
            const flags = new StaticFeatureFlags({ enabled: true });

            expect(flags.variant('enabled', false)).toBe(true);
        });

        it('returns the fallback when the key is absent', () => {
            const flags = new StaticFeatureFlags();

            expect(flags.variant('missing', 'default')).toBe('default');
        });

        it('returns the fallback when the stored type is string but fallback is number', () => {
            const flags = new StaticFeatureFlags({ limit: 'many' });

            expect(flags.variant('limit', 0)).toBe(0);
        });

        it('returns the fallback when the stored type is number but fallback is string', () => {
            const flags = new StaticFeatureFlags({ flow: 42 });

            expect(flags.variant('flow', 'default')).toBe('default');
        });

        it('returns the fallback when the stored type is boolean but fallback is string', () => {
            const flags = new StaticFeatureFlags({ flow: true });

            expect(flags.variant('flow', 'default')).toBe('default');
        });
    });

    describe('setContext', () => {
        it('stores the context and exposes it via the context getter', () => {
            const flags = new StaticFeatureFlags();
            const ctx = { userId: 'u1', plan: 'pro', beta: true };

            flags.setContext(ctx);

            expect(flags.context).toEqual(ctx);
        });

        it('replaces a previously stored context', () => {
            const flags = new StaticFeatureFlags();

            flags.setContext({ userId: 'u1' });
            flags.setContext({ userId: 'u2' });

            expect(flags.context).toEqual({ userId: 'u2' });
        });
    });

    describe('onChange', () => {
        it('calls the handler when replace() is invoked', () => {
            const flags = new StaticFeatureFlags();
            const handler = vi.fn();

            flags.onChange(handler);
            flags.replace({ 'new-flag': true });

            expect(handler).toHaveBeenCalledOnce();
        });

        it('calls multiple handlers when replace() is invoked', () => {
            const flags = new StaticFeatureFlags();
            const handlerA = vi.fn();
            const handlerB = vi.fn();

            flags.onChange(handlerA);
            flags.onChange(handlerB);
            flags.replace({});

            expect(handlerA).toHaveBeenCalledOnce();
            expect(handlerB).toHaveBeenCalledOnce();
        });

        it('stops delivering events after the returned unsubscribe is called', () => {
            const flags = new StaticFeatureFlags();
            const handler = vi.fn();

            const unsubscribe = flags.onChange(handler);

            unsubscribe();
            flags.replace({ after: true });

            expect(handler).not.toHaveBeenCalled();
        });

        it('leaves other subscribers intact after one unsubscribes', () => {
            const flags = new StaticFeatureFlags();
            const handlerA = vi.fn();
            const handlerB = vi.fn();

            const unsubscribeA = flags.onChange(handlerA);

            flags.onChange(handlerB);
            unsubscribeA();
            flags.replace({});

            expect(handlerA).not.toHaveBeenCalled();
            expect(handlerB).toHaveBeenCalledOnce();
        });
    });

    describe('replace', () => {
        it('updates the flag set so subsequent reads see the new values', () => {
            const flags = new StaticFeatureFlags({ feat: false });

            flags.replace({ feat: true });

            expect(flags.isEnabled('feat')).toBe(true);
        });

        it('notifies all handlers synchronously', () => {
            const flags = new StaticFeatureFlags();
            const calls: string[] = [];

            flags.onChange(() => calls.push('a'));
            flags.onChange(() => calls.push('b'));
            flags.replace({});

            expect(calls).toEqual(['a', 'b']);
        });
    });
});
