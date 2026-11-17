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
        it('defaults to an empty flag set', () => {
            const flags = new StaticFeatureFlags();

            expect(flags.isEnabled('missing')).toBe(false);
        });

        it('accepts an initial flag record', () => {
            const flags = new StaticFeatureFlags({ 'my-flag': true });

            expect(flags.isEnabled('my-flag')).toBe(true);
        });
    });

    describe('isEnabled', () => {
        it.each([true, false])('returns a stored %s', stored => {
            expect(new StaticFeatureFlags({ 'feat-a': stored }).isEnabled('feat-a')).toBe(stored);
        });

        it('returns false for an absent flag', () => {
            const flags = new StaticFeatureFlags();

            expect(flags.isEnabled('missing')).toBe(false);
        });

        it('returns a custom fallback for an absent flag', () => {
            const flags = new StaticFeatureFlags();

            expect(flags.isEnabled('missing', true)).toBe(true);
        });

        it('returns the fallback for a string value', () => {
            const flags = new StaticFeatureFlags({ 'variant-flag': 'blue' });

            expect(flags.isEnabled('variant-flag')).toBe(false);
        });

        it('returns the fallback for a number value', () => {
            const flags = new StaticFeatureFlags({ 'numeric-flag': 42 });

            expect(flags.isEnabled('numeric-flag', true)).toBe(true);
        });
    });

    describe('variant', () => {
        it.each([
            ['string', 'checkout-v2', 'checkout-v1'],
            ['number', 100, 0],
            ['boolean', true, false],
        ])('returns a stored %s matching the fallback type', (_, stored, fallback) => {
            expect(new StaticFeatureFlags({ flag: stored }).variant('flag', fallback)).toBe(stored);
        });

        it('returns the fallback for an absent key', () => {
            const flags = new StaticFeatureFlags();

            expect(flags.variant('missing', 'default')).toBe('default');
        });

        it.each([
            ['string', 'number', 'many', 0],
            ['number', 'string', 42, 'default'],
            ['boolean', 'string', true, 'default'],
        ])('returns the fallback for a stored %s against a %s fallback', (_, _type, stored, fallback) => {
            expect(new StaticFeatureFlags({ flag: stored }).variant('flag', fallback)).toBe(fallback);
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

    describe('onChange', () => {
        it('notifies a handler on replace', () => {
            const flags = new StaticFeatureFlags();
            const handler = vi.fn();

            flags.onChange(handler);
            flags.replace({ 'new-flag': true });

            expect(handler).toHaveBeenCalledOnce();
        });

        it('notifies every handler on replace', () => {
            const flags = new StaticFeatureFlags();
            const handlerA = vi.fn();
            const handlerB = vi.fn();

            flags.onChange(handlerA);
            flags.onChange(handlerB);
            flags.replace({});

            expect(handlerA).toHaveBeenCalledOnce();
            expect(handlerB).toHaveBeenCalledOnce();
        });

        it('stops notifying after unsubscribe', () => {
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
    });
});
