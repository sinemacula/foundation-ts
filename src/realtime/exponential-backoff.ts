/**
 * Exponential backoff delay calculator.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { clampTimerDelay } from '../support/timer';

/**
 * How a delay is randomised below its cap.
 *
 * - `none`: the cap itself
 * - `full`: uniform between 0 and the cap
 * - `equal`: uniform between half the cap and the cap
 */
export type BackoffJitter = 'none' | 'full' | 'equal';

/** Construction options for {@link ExponentialBackoff}. */
export interface ExponentialBackoffOptions {
    /** Delay in milliseconds for the first attempt. Defaults to 1000. */
    readonly initialDelay?: number;

    /** Multiplicative growth factor applied each attempt. Defaults to 2. */
    readonly multiplier?: number;

    /** Upper bound in milliseconds for any delay. Defaults to 30000. */
    readonly maxDelay?: number;

    /** How each delay is randomised below its cap. Defaults to `'none'`. */
    readonly jitter?: BackoffJitter;

    /** Uniform sample in [0, 1) used for jitter. Defaults to `Math.random`. */
    readonly random?: () => number;
}

/**
 * Computes capped exponential backoff delays for reconnects and retries.
 *
 * Each delay is capped at `maxDelay` and at the largest delay timers honour,
 * then randomised below that cap per `jitter`.
 */
export class ExponentialBackoff {
    /** Delay in milliseconds for the first attempt. */
    readonly #initialDelay: number;

    /** Multiplicative growth factor applied each attempt. */
    readonly #multiplier: number;

    /** Upper bound in milliseconds every delay is clamped to. */
    readonly #cap: number;

    /** How each delay is randomised below its cap. */
    readonly #jitter: BackoffJitter;

    /** The injected sample source, or undefined for `Math.random`. */
    readonly #random: (() => number) | undefined;

    /**
     * Construct a backoff calculator.
     *
     * @throws {RangeError} when `initialDelay` is not a finite number of at
     * least 0, `multiplier` is not a finite number of at least 1, or `maxDelay`
     * is NaN or negative
     */
    constructor(options?: ExponentialBackoffOptions) {
        const initialDelay = options?.initialDelay ?? 1_000;
        const multiplier = options?.multiplier ?? 2;
        const maxDelay = options?.maxDelay ?? 30_000;

        if (!Number.isFinite(initialDelay) || initialDelay < 0) {
            throw new RangeError(
                `The backoff initialDelay must be a finite number of at least 0, got ${initialDelay}.`,
            );
        }

        if (!Number.isFinite(multiplier) || multiplier < 1) {
            throw new RangeError(`The backoff multiplier must be a finite number of at least 1, got ${multiplier}.`);
        }

        if (Number.isNaN(maxDelay) || maxDelay < 0) {
            throw new RangeError(`The backoff maxDelay must be a number of at least 0, got ${maxDelay}.`);
        }

        this.#initialDelay = initialDelay;
        this.#multiplier = multiplier;
        this.#cap = clampTimerDelay(maxDelay);
        this.#jitter = options?.jitter ?? 'none';
        this.#random = options?.random;
    }

    /**
     * Compute the delay in milliseconds for an attempt.
     *
     * @param attempt - zero-based attempt counter; negative values are treated
     * as 0
     * @throws {RangeError} when `attempt` is not finite, or a jitter sample is
     * not a number in [0, 1)
     */
    delayFor(attempt: number): number {
        if (!Number.isFinite(attempt)) {
            throw new RangeError(`The backoff attempt must be a finite number, got ${attempt}.`);
        }

        // 0 * Infinity is NaN, so a zero initial delay short-circuits.
        const capped =
            this.#initialDelay === 0
                ? 0
                : Math.min(this.#initialDelay * this.#multiplier ** Math.max(0, attempt), this.#cap);

        if (this.#jitter === 'none' || capped === 0) {
            return capped;
        }

        const floor = this.#jitter === 'equal' ? capped / 2 : 0;

        return floor + this.#sample() * (capped - floor);
    }

    /**
     * Draw one jitter sample, resolving `Math.random` at call time.
     *
     * @throws {RangeError} when the sample is not a number in [0, 1)
     */
    #sample(): number {
        const sample = (this.#random ?? Math.random)();

        if (!(sample >= 0 && sample < 1)) {
            throw new RangeError(`The backoff random source must return a number in [0, 1), got ${sample}.`);
        }

        return sample;
    }
}
