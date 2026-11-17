/**
 * Config-driven feature-flag adapter backed by an in-memory record.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { FeatureFlags, FlagEvaluationContext, FlagsChangeHandler, FlagValue } from './feature-flags';

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

    constructor(flags: Readonly<Record<string, FlagValue>> = {}) {
        this.#flags = flags;
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
     * Resolve a variant flag, or the fallback when it is absent or its runtime
     * type differs from the fallback's.
     *
     * @param fallback - its type pins the return type
     */
    variant<Value extends FlagValue>(key: string, fallback: Value): Value {
        const value = this.#flags[key];

        if (typeof value === typeof fallback) {
            // Equal typeof makes value a Value; the compiler cannot infer it.
            return value as Value;
        }

        return fallback;
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
     * Swap the entire flag set and synchronously notify every change handler.
     */
    replace(flags: Readonly<Record<string, FlagValue>>): void {
        this.#flags = flags;

        for (const handler of this.#handlers) {
            handler();
        }
    }

    /**
     * The stored evaluation context, for handing off to a remote provider that
     * takes context at initialisation.
     */
    get context(): FlagEvaluationContext {
        return this.#context;
    }
}
