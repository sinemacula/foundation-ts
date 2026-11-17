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
            it.each([true, false])('returns a stored %s over the opposite fallback', stored => {
                expect(harness.create({ flag: stored }).flags.isEnabled('flag', !stored)).toBe(stored);
            });

            it('defaults a missing flag to false', () => {
                expect(harness.create({}).flags.isEnabled('missing')).toBe(false);
            });

            it('returns the fallback for a missing flag', () => {
                expect(harness.create({}).flags.isEnabled('missing', true)).toBe(true);
            });

            it.each([
                ['on', true],
                ['off', false],
                ['', true],
                [1, false],
                [0, true],
            ])('returns the fallback for the non-boolean %j over a %s fallback', (stored, fallback) => {
                expect(harness.create({ flag: stored }).flags.isEnabled('flag', fallback)).toBe(fallback);
            });
        });

        describe('variant', () => {
            it.each([
                ['checkout-v2', 'checkout-v1'],
                ['', 'default'],
                [100, 0],
                [0, 1],
                [true, false],
                [false, true],
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

            it('runs a handler subscribed twice once per registration, each unsubscribe removing its own', async () => {
                const { flags, change } = harness.create({});
                const handler = vi.fn();
                const unsubscribe = flags.onChange(handler);

                flags.onChange(handler);
                await change({ flag: true });
                unsubscribe();
                unsubscribe();
                await change({ flag: false });

                expect(handler).toHaveBeenCalledTimes(3);
            });

            it('runs a handler subscribed during a change only from the next change', async () => {
                const { flags, change } = harness.create({ step: 0 });
                const late = vi.fn(() => flags.variant('step', 0));
                let subscribed = false;

                flags.onChange(() => {
                    if (!subscribed) {
                        subscribed = true;
                        flags.onChange(late);
                    }
                });
                await change({ step: 1 });

                expect(late).not.toHaveBeenCalled();

                await change({ step: 2 });

                expect(late).toHaveBeenCalledOnce();
                expect(late).toHaveLastReturnedWith(2);
            });

            it('skips a handler unsubscribed during a change', async () => {
                const { flags, change } = harness.create({});
                const removed = vi.fn();
                const unsubscribes: Array<() => void> = [];

                flags.onChange(() => {
                    unsubscribes[0]?.();
                });
                unsubscribes.push(flags.onChange(removed));
                await change({ flag: true });

                expect(removed).not.toHaveBeenCalled();
            });

            it('delivers a change made by a handler once the current delivery has finished', async () => {
                const { flags, change } = harness.create({ step: 0 });
                const seen: string[] = [];
                let nested = Promise.resolve();
                let changed = false;

                flags.onChange(() => {
                    seen.push(`a:${String(flags.variant('step', 0))}`);

                    if (!changed) {
                        changed = true;
                        nested = Promise.resolve(change({ step: 2 }));
                    }
                });
                flags.onChange(() => {
                    seen.push(`b:${String(flags.variant('step', 0))}`);
                });
                await change({ step: 1 });
                await nested;

                expect(seen).toStrictEqual(['a:1', 'b:2', 'a:2', 'b:2']);
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
