/**
 * Exponential backoff delay calculator.
 *
 * Produces deterministic, jitter-free delays so that reconnect schedules are
 * fully predictable in tests. Callers that need jitter may wrap the returned
 * delay: `backoff.delayFor(attempt) + Math.random() * 500`.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/** Construction options for {@link ExponentialBackoff}. */
export interface ExponentialBackoffOptions {
    /** Delay in milliseconds for the first attempt. Defaults to 1 000. */
    readonly initialDelay?: number;

    /** Multiplicative growth factor applied each attempt. Defaults to 2. */
    readonly multiplier?: number;

    /** Upper bound in milliseconds; delays are clamped to this value. Defaults to 30 000. */
    readonly maxDelay?: number;
}

/**
 * Computes capped exponential backoff delays for reconnect strategies.
 *
 * No jitter is applied deliberately: deterministic output makes reconnect
 * behaviour fully testable without fake random number generators. Jitter is a
 * caller concern and can be layered on top of
 * {@link ExponentialBackoff.delayFor}.
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
     *
     * @param options - optional overrides for initial delay, multiplier, and
     * max delay
     */
    constructor(options?: ExponentialBackoffOptions) {
        this.#initialDelay = options?.initialDelay ?? 1_000;
        this.#multiplier = options?.multiplier ?? 2;
        this.#maxDelay = options?.maxDelay ?? 30_000;
    }

    /**
     * Compute the delay in milliseconds for a given attempt index.
     *
     * @param attempt - zero-based attempt counter; negative values are treated
     * as 0
     * @returns the delay in milliseconds, capped at `maxDelay`
     */
    delayFor(attempt: number): number {
        const normalised = Math.max(0, attempt);
        const delay = this.#initialDelay * this.#multiplier ** normalised;

        return Math.min(delay, this.#maxDelay);
    }
}
