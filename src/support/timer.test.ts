/**
 * Unit tests for the timer delay bounds.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { clampTimerDelay, MAX_TIMER_DELAY } from './timer';

describe('MAX_TIMER_DELAY', () => {
    it('is the largest signed 32-bit integer', () => {
        expect(MAX_TIMER_DELAY).toBe(2 ** 31 - 1);
    });
});

describe('clampTimerDelay', () => {
    it.each([
        [0, 0],
        [1_000, 1_000],
        [MAX_TIMER_DELAY, MAX_TIMER_DELAY],
        [MAX_TIMER_DELAY + 1, MAX_TIMER_DELAY],
        [Number.POSITIVE_INFINITY, MAX_TIMER_DELAY],
        [-5, -5],
    ])('clamps %s to %s', (delay, expected) => {
        expect(clampTimerDelay(delay)).toBe(expected);
    });

    it('leaves NaN to the timer', () => {
        expect(clampTimerDelay(Number.NaN)).toBeNaN();
    });
});
