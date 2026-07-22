/**
 * Unit tests for exponential-backoff.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { ExponentialBackoff } from './exponential-backoff';

describe('ExponentialBackoff', () => {
    describe('default options', () => {
        it('returns the initial delay for attempt 0', () => {
            const backoff = new ExponentialBackoff();

            expect(backoff.delayFor(0)).toBe(1_000);
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
    });

    describe('custom options', () => {
        it('respects a custom initial delay', () => {
            const backoff = new ExponentialBackoff({ initialDelay: 500 });

            expect(backoff.delayFor(0)).toBe(500);
        });

        it('respects a custom multiplier', () => {
            const backoff = new ExponentialBackoff({ initialDelay: 100, multiplier: 3 });

            expect(backoff.delayFor(1)).toBe(300);
            expect(backoff.delayFor(2)).toBe(900);
        });

        it('respects a custom max delay', () => {
            const backoff = new ExponentialBackoff({ initialDelay: 1_000, maxDelay: 5_000 });

            expect(backoff.delayFor(3)).toBe(5_000);
        });

        it('returns the exact max delay when computed value equals it', () => {
            const backoff = new ExponentialBackoff({ initialDelay: 1_000, multiplier: 2, maxDelay: 4_000 });

            expect(backoff.delayFor(2)).toBe(4_000);
        });
    });
});
