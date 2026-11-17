/**
 * Unit tests for exponential-backoff.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_TIMER_DELAY } from '../support/timer';
import { type BackoffJitter, ExponentialBackoff, type ExponentialBackoffOptions } from './exponential-backoff';

/**
 * Every option combination of the sweep grid.
 */
function sweepGrid(): [number, number, number][] {
    const grid: [number, number, number][] = [];

    for (const initialDelay of [0, 1, 1_000]) {
        for (const multiplier of [1, 2, 10]) {
            for (const maxDelay of [0, 30_000, Number.POSITIVE_INFINITY]) {
                grid.push([initialDelay, multiplier, maxDelay]);
            }
        }
    }

    return grid;
}

describe('ExponentialBackoff', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('default options', () => {
        it('returns the initial delay for attempt 0', () => {
            expect(new ExponentialBackoff().delayFor(0)).toBe(1_000);
        });

        it('doubles the delay on each subsequent attempt', () => {
            const backoff = new ExponentialBackoff();

            expect(backoff.delayFor(1)).toBe(2_000);
            expect(backoff.delayFor(2)).toBe(4_000);
            expect(backoff.delayFor(3)).toBe(8_000);
        });

        it('caps the delay at 30 000 ms', () => {
            const backoff = new ExponentialBackoff();

            expect(backoff.delayFor(10)).toBe(30_000);
            expect(backoff.delayFor(100)).toBe(30_000);
        });

        it('treats negative attempts as 0', () => {
            const backoff = new ExponentialBackoff();

            expect(backoff.delayFor(-1)).toBe(1_000);
            expect(backoff.delayFor(-99)).toBe(1_000);
        });

        it('keeps a fractional attempt', () => {
            expect(new ExponentialBackoff({ initialDelay: 100, multiplier: 4 }).delayFor(0.5)).toBe(200);
        });

        it('applies no jitter and never samples', () => {
            const random = vi.spyOn(Math, 'random');

            expect(new ExponentialBackoff().delayFor(1)).toBe(2_000);
            expect(random).not.toHaveBeenCalled();
        });
    });

    describe('custom options', () => {
        it('respects a custom initial delay', () => {
            expect(new ExponentialBackoff({ initialDelay: 500 }).delayFor(0)).toBe(500);
        });

        it('respects a custom multiplier', () => {
            const backoff = new ExponentialBackoff({ initialDelay: 100, multiplier: 3 });

            expect(backoff.delayFor(1)).toBe(300);
            expect(backoff.delayFor(2)).toBe(900);
        });

        it('respects a custom max delay', () => {
            expect(new ExponentialBackoff({ initialDelay: 1_000, maxDelay: 5_000 }).delayFor(3)).toBe(5_000);
        });

        it('returns the exact max delay when computed value equals it', () => {
            const backoff = new ExponentialBackoff({ initialDelay: 1_000, multiplier: 2, maxDelay: 4_000 });

            expect(backoff.delayFor(2)).toBe(4_000);
        });
    });

    describe('bounds', () => {
        it.each(sweepGrid())(
            'stays finite, within the cap and non-decreasing (initialDelay %s, multiplier %s, maxDelay %s)',
            (initialDelay, multiplier, maxDelay) => {
                const backoff = new ExponentialBackoff({ initialDelay, multiplier, maxDelay });
                const cap = Math.min(maxDelay, MAX_TIMER_DELAY);
                const violations: string[] = [];
                let previous = 0;

                for (let attempt = 0; attempt <= 2_000; attempt++) {
                    const delay = backoff.delayFor(attempt);

                    if (!Number.isFinite(delay) || delay < previous || delay > cap) {
                        violations.push(`attempt ${attempt}: ${delay} after ${previous}`);
                    }

                    previous = delay;
                }

                expect(violations).toEqual([]);

                const plateau = multiplier === 1 ? initialDelay : Number.POSITIVE_INFINITY;

                expect(previous).toBe(initialDelay === 0 ? 0 : Math.min(plateau, cap));
            },
        );

        it.each([
            ['2^31-1', MAX_TIMER_DELAY, MAX_TIMER_DELAY],
            ['2^31', 2 ** 31, MAX_TIMER_DELAY],
            ['Infinity', Number.POSITIVE_INFINITY, MAX_TIMER_DELAY],
        ])('clamps a maxDelay of %s to the largest timer delay', (_label, maxDelay, expected) => {
            expect(new ExponentialBackoff({ maxDelay }).delayFor(2_000)).toBe(expected);
        });

        it('clamps an initial delay above the cap', () => {
            const backoff = new ExponentialBackoff({ initialDelay: 2 ** 32, maxDelay: Number.POSITIVE_INFINITY });

            expect(backoff.delayFor(0)).toBe(MAX_TIMER_DELAY);
        });

        it('returns 0 for every attempt when the initial delay is 0', () => {
            const backoff = new ExponentialBackoff({ initialDelay: 0 });

            expect([0, 1, 1_024, 2_000].map(attempt => backoff.delayFor(attempt))).toEqual([0, 0, 0, 0]);
        });
    });

    describe('jitter', () => {
        it.each<[BackoffJitter, number, number]>([
            ['full', 0, 0],
            ['full', 0.5, 2_000],
            ['full', 0.999, 3_996],
            ['equal', 0, 2_000],
            ['equal', 0.5, 3_000],
            ['equal', 0.999, 3_998],
        ])('%s jitter with random %s gives %s ms for a 4000 ms cap', (jitter, sample, expected) => {
            const backoff = new ExponentialBackoff({ initialDelay: 1_000, jitter, random: () => sample });

            expect(backoff.delayFor(2)).toBeCloseTo(expected, 9);
        });

        it.each<[BackoffJitter, number]>([
            ['full', 0.999 * MAX_TIMER_DELAY],
            ['equal', MAX_TIMER_DELAY / 2 + (0.999 * MAX_TIMER_DELAY) / 2],
        ])('keeps %s jitter within the clamped cap', (jitter, expected) => {
            const backoff = new ExponentialBackoff({
                initialDelay: 1_000,
                maxDelay: Number.POSITIVE_INFINITY,
                jitter,
                random: () => 0.999,
            });

            expect(backoff.delayFor(2_000)).toBeCloseTo(expected, 3);
        });

        it('defaults to Math.random, resolved at call time', () => {
            const backoff = new ExponentialBackoff({ initialDelay: 1_000, jitter: 'full' });

            vi.spyOn(Math, 'random').mockReturnValue(0.25);

            expect(backoff.delayFor(0)).toBe(250);
        });

        it('does not sample for a zero cap', () => {
            const random = vi.fn(() => 0.5);

            expect(new ExponentialBackoff({ initialDelay: 0, jitter: 'full', random }).delayFor(3)).toBe(0);
            expect(new ExponentialBackoff({ maxDelay: 0, jitter: 'equal', random }).delayFor(3)).toBe(0);
            expect(random).not.toHaveBeenCalled();
        });

        it('does not sample without jitter', () => {
            const random = vi.fn(() => 0.5);

            expect(new ExponentialBackoff({ jitter: 'none', random }).delayFor(1)).toBe(2_000);
            expect(random).not.toHaveBeenCalled();
        });

        it.each([1, -0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
            'throws a RangeError when the random source returns %s',
            sample => {
                const backoff = new ExponentialBackoff({ jitter: 'equal', random: () => sample });

                expect(() => backoff.delayFor(0)).toThrow(
                    new RangeError(`The backoff random source must return a number in [0, 1), got ${sample}.`),
                );
            },
        );
    });

    describe('validation', () => {
        it.each<[string, ExponentialBackoffOptions, string]>([
            [
                'a negative initialDelay',
                { initialDelay: -1 },
                'The backoff initialDelay must be a finite number of at least 0, got -1.',
            ],
            [
                'a NaN initialDelay',
                { initialDelay: Number.NaN },
                'The backoff initialDelay must be a finite number of at least 0, got NaN.',
            ],
            [
                'an infinite initialDelay',
                { initialDelay: Number.POSITIVE_INFINITY },
                'The backoff initialDelay must be a finite number of at least 0, got Infinity.',
            ],
            [
                'a multiplier below 1',
                { multiplier: 0.5 },
                'The backoff multiplier must be a finite number of at least 1, got 0.5.',
            ],
            [
                'a NaN multiplier',
                { multiplier: Number.NaN },
                'The backoff multiplier must be a finite number of at least 1, got NaN.',
            ],
            [
                'an infinite multiplier',
                { multiplier: Number.POSITIVE_INFINITY },
                'The backoff multiplier must be a finite number of at least 1, got Infinity.',
            ],
            ['a negative maxDelay', { maxDelay: -1 }, 'The backoff maxDelay must be a number of at least 0, got -1.'],
            [
                'a NaN maxDelay',
                { maxDelay: Number.NaN },
                'The backoff maxDelay must be a number of at least 0, got NaN.',
            ],
        ])('throws a RangeError for %s', (_label, options, message) => {
            expect(() => new ExponentialBackoff(options)).toThrow(new RangeError(message));
        });

        it.each([
            [{ initialDelay: 0 }, 0],
            [{ multiplier: 1 }, 1_000],
            [{ maxDelay: 0 }, 0],
        ])('accepts the boundary option %o', (options, expected) => {
            expect(new ExponentialBackoff(options).delayFor(0)).toBe(expected);
        });

        it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
            'throws a RangeError for a %s attempt',
            attempt => {
                expect(() => new ExponentialBackoff().delayFor(attempt)).toThrow(
                    new RangeError(`The backoff attempt must be a finite number, got ${attempt}.`),
                );
            },
        );
    });
});
