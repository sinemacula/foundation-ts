/**
 * Exponential backoff delay calculator.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/** Construction options for {@link ExponentialBackoff}. */
export interface ExponentialBackoffOptions {
    /** Delay in milliseconds for the first attempt. Defaults to 1000. */
    readonly initialDelay?: number;

    /** Multiplicative growth factor applied each attempt. Defaults to 2. */
    readonly multiplier?: number;

    /** Upper bound in milliseconds for any delay. Defaults to 30000. */
    readonly maxDelay?: number;
}

/**
 * Computes capped exponential backoff delays for reconnect strategies.
 *
 * No jitter is applied, so schedules are deterministic; callers that want
 * jitter add it to the result of {@link ExponentialBackoff.delayFor}.
 */
export class ExponentialBackoff {
    /** Delay in milliseconds for the first attempt. */
    readonly #initialDelay: number;

    /** Multiplicative growth factor applied each attempt. */
    readonly #multiplier: number;

    /** Upper bound in milliseconds delays are clamped to. */
    readonly #maxDelay: number;

    /**
     * Construct a backoff calculator.
     */
    constructor(options?: ExponentialBackoffOptions) {
        this.#initialDelay = options?.initialDelay ?? 1_000;
        this.#multiplier = options?.multiplier ?? 2;
        this.#maxDelay = options?.maxDelay ?? 30_000;
    }

    /**
     * Compute the delay in milliseconds for an attempt, capped at `maxDelay`.
     *
     * @param attempt - zero-based attempt counter; negative values are treated
     * as 0
     */
    delayFor(attempt: number): number {
        const normalised = Math.max(0, attempt);
        const delay = this.#initialDelay * this.#multiplier ** normalised;

        return Math.min(delay, this.#maxDelay);
    }
}
