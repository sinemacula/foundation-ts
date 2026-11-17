/**
 * FeatureFlags behaviour contract, run by every adapter suite.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import type { FeatureFlags, FlagValue } from '../feature-flags';

/** A flag record as the contract seeds and changes it. */
type FlagRecord = Readonly<Record<string, FlagValue>>;

/** An adapter under test plus the means to change its flags. */
export interface FeatureFlagsContractSubject {
    /** The adapter under test. */
    readonly flags: FeatureFlags;

    /**
     * Replace the adapter's flag set, settling only after the update and its
     * change notifications have completed.
     */
    change(next: FlagRecord): void | Promise<void>;
}

/** The adapter-specific hooks the contract is parameterised by. */
export interface FeatureFlagsContractHarness {
    /**
     * Construct a non-targeting adapter that resolves the given flags.
     */
    create(flags: FlagRecord): FeatureFlagsContractSubject;
}

/**
 * Assert the shared FeatureFlags contract against one adapter.
 *
 * @param harness - the adapter-specific construction harness
 */
export function describeFeatureFlagsContract(harness: FeatureFlagsContractHarness): void {
    describe('FeatureFlags contract', () => {
        describe('isEnabled', () => {
            it.each([true, false])('returns a stored %s', stored => {
                expect(harness.create({ flag: stored }).flags.isEnabled('flag')).toBe(stored);
            });

            it('defaults a missing flag to false', () => {
                expect(harness.create({}).flags.isEnabled('missing')).toBe(false);
            });

            it('returns the fallback for a missing flag', () => {
                expect(harness.create({}).flags.isEnabled('missing', true)).toBe(true);
            });

            it.each(['on', 1])('returns the fallback for the non-boolean %j', stored => {
                expect(harness.create({ flag: stored }).flags.isEnabled('flag', true)).toBe(true);
            });
        });

        describe('variant', () => {
            it.each([
                ['checkout-v2', 'checkout-v1'],
                [100, 0],
                [true, false],
            ])('returns the stored %j for a fallback of the same type', (stored, fallback) => {
                expect(harness.create({ flag: stored }).flags.variant('flag', fallback)).toBe(stored);
            });

            it.each([
                ['many', 0],
                [42, 'default'],
                [true, 'default'],
            ])('returns the fallback when %j differs from its type', (stored, fallback) => {
                expect(harness.create({ flag: stored }).flags.variant('flag', fallback)).toBe(fallback);
            });

            it('returns the fallback for a missing key', () => {
                expect(harness.create({}).flags.variant('missing', 'default')).toBe('default');
            });
        });

        describe('onChange', () => {
            it('runs a handler once per change, observing the new values', async () => {
                const { flags, change } = harness.create({ flag: false });
                const seen: boolean[] = [];

                flags.onChange(() => seen.push(flags.isEnabled('flag')));
                await change({ flag: true });
                await change({ flag: false });

                expect(seen).toStrictEqual([true, false]);
            });

            it('runs every handler', async () => {
                const { flags, change } = harness.create({});
                const first = vi.fn();
                const second = vi.fn();

                flags.onChange(first);
                flags.onChange(second);
                await change({ flag: true });

                expect(first).toHaveBeenCalledOnce();
                expect(second).toHaveBeenCalledOnce();
            });

            it('stops one handler on unsubscribe and leaves the others', async () => {
                const { flags, change } = harness.create({});
                const removed = vi.fn();
                const kept = vi.fn();

                const unsubscribe = flags.onChange(removed);

                flags.onChange(kept);
                unsubscribe();
                unsubscribe();
                await change({ flag: true });

                expect(removed).not.toHaveBeenCalled();
                expect(kept).toHaveBeenCalledOnce();
            });

            it('isolates a throwing handler from the others and from the change', async () => {
                const { flags, change } = harness.create({ flag: false });
                const failure = new Error('handler failed');
                const handler = vi.fn();

                flags.onChange(() => {
                    throw failure;
                });
                flags.onChange(handler);

                await expect(Promise.resolve().then(() => change({ flag: true }))).resolves.toBeUndefined();
                expect(handler).toHaveBeenCalledOnce();
                expect(flags.isEnabled('flag')).toBe(true);
            });
        });

        describe('setContext', () => {
            it('accepts a context without altering resolved values', () => {
                const { flags } = harness.create({ enabled: true, plan: 'pro' });

                expect(() => flags.setContext({ userId: 'u1', seats: 5, beta: true })).not.toThrow();
                expect(flags.isEnabled('enabled')).toBe(true);
                expect(flags.variant('plan', 'free')).toBe('pro');
            });
        });
    });
}
