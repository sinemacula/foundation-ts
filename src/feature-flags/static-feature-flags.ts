/**
 * Config-driven feature-flag adapter backed by an in-memory record.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { FeatureFlags, FlagEvaluationContext, FlagsChangeHandler, FlagValue } from './feature-flags';

/**
 * Construction options for {@link StaticFeatureFlags}.
 */
export interface StaticFeatureFlagsOptions {
    /** Receives a synchronous handler throw (never a rejected promise); a throwing sink is ignored. */
    readonly onError?: (error: unknown) => void;
}

/**
 * Feature flags resolved from a plain record, such as runtime configuration.
 */
export class StaticFeatureFlags implements FeatureFlags {
    /** The current flag set. */
    #flags: Readonly<Record<string, FlagValue>>;

    /** The stored evaluation context. */
    #context: FlagEvaluationContext = {};

    /** The registered flag-change subscribers. */
    readonly #handlers: Set<FlagsChangeHandler> = new Set();

    /** Receives a contained change-handler failure. */
    readonly #onError: (error: unknown) => void;

    constructor(flags: Readonly<Record<string, FlagValue>> = {}, options: StaticFeatureFlagsOptions = {}) {
        this.#flags = flags;
        this.#onError = options.onError ?? (() => undefined);
    }

    /**
     * Resolve a boolean flag, or the fallback when absent or non-boolean.
     *
     * @param fallback - defaults to `false`
     */
    isEnabled(key: string, fallback = false): boolean {
        const value = this.#flags[key];

        return typeof value === 'boolean' ? value : fallback;
    }

    /**
     * Resolve a string variant flag, or the fallback when it is absent or not a
     * string.
     */
    variant(key: string, fallback: string): string;

    /**
     * Resolve a numeric variant flag, or the fallback when it is absent or not
     * a number.
     */
    variant(key: string, fallback: number): number;

    /**
     * Resolve a boolean variant flag, or the fallback when it is absent or not
     * a boolean.
     */
    variant(key: string, fallback: boolean): boolean;

    /**
     * Resolve a variant flag narrowed to an explicit `Value`, or the fallback
     * when it is absent or its runtime type differs from the fallback's. The
     * narrowing is an unchecked assertion.
     */
    variant<Value extends FlagValue = FlagValue>(key: string, fallback: NoInfer<Value>): NoInfer<Value>;

    /**
     * Resolve a variant flag, or the fallback when it is absent or its runtime
     * type differs from the fallback's.
     */
    variant(key: string, fallback: FlagValue): FlagValue {
        const value = this.#flags[key] ?? fallback;

        return typeof value === typeof fallback ? value : fallback;
    }

    /**
     * Store the evaluation context for handoff to a remote provider; this
     * adapter does not target flags itself.
     */
    setContext(context: FlagEvaluationContext): void {
        this.#context = context;
    }

    /**
     * Subscribe to the flag-set swaps made by {@link replace}.
     *
     * @returns an unsubscribe function
     */
    onChange(handler: FlagsChangeHandler): () => void {
        this.#handlers.add(handler);

        return () => {
            this.#handlers.delete(handler);
        };
    }

    /**
     * Swap the entire flag set and synchronously notify every change handler,
     * passing a throwing handler's error to the `onError` sink.
     */
    replace(flags: Readonly<Record<string, FlagValue>>): void {
        this.#flags = flags;

        for (const handler of this.#handlers) {
            try {
                handler();
            } catch (error) {
                this.#report(error);
            }
        }
    }

    /**
     * The stored evaluation context, for handing off to a remote provider that
     * takes context at initialisation.
     */
    get context(): FlagEvaluationContext {
        return this.#context;
    }

    /**
     * Pass a contained error to the `onError` sink, ignoring a throwing sink so
     * one failure never starves the remaining handlers.
     */
    #report(error: unknown): void {
        try {
            this.#onError(error);
        } catch {
            // The sink is the last resort; nothing is left to report to.
        }
    }
}
