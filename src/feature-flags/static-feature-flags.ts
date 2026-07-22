/**
 * Config-driven static feature-flag adapter.
 *
 * Resolves flags from an in-memory record populated at construction time. The
 * {@link StaticFeatureFlags.replace} method swaps the entire flag set and
 * notifies every registered change handler - providing the seam that tests and
 * future remote-refresh adapters use.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { FeatureFlags, FlagEvaluationContext, FlagsChangeHandler, FlagValue } from './feature-flags';

/**
 * A static, in-process feature-flag adapter backed by a plain object.
 *
 * Use this adapter when flags are delivered via runtime configuration. Swap it
 * for a remote-provider adapter (e.g. LaunchDarkly) behind the
 * {@link FeatureFlags} port when live targeting is needed.
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
     * Resolve a boolean flag. Returns the stored value when it is a boolean;
     * otherwise returns the fallback.
     *
     * @param key - the flag key to look up
     * @param fallback - returned when the flag is absent or non-boolean;
     * defaults to `false`
     * @returns the resolved boolean flag value, or the fallback
     */
    isEnabled(key: string, fallback = false): boolean {
        const value = this.#flags[key];

        return typeof value === 'boolean' ? value : fallback;
    }

    /**
     * Resolve a variant flag. Returns the stored value when its runtime type
     * matches the fallback's type; otherwise returns the fallback.
     *
     * @param key - the flag key to look up
     * @param fallback - returned when the flag is absent or the wrong type; its
     * type pins the return type
     * @returns the resolved variant value, or the fallback
     */
    variant<Value extends FlagValue>(key: string, fallback: Value): Value {
        const value = this.#flags[key];

        if (typeof value === typeof fallback) {
            // The typeof guard makes the runtime type of value equal to Value;
            // the cast is the only way to satisfy TypeScript across FlagValue
            // union members.
            return value as Value;
        }

        return fallback;
    }

    /**
     * Store the evaluation context for handoff to a future remote provider. The
     * static adapter does not target flags itself.
     *
     * @param context - the attribute map to store
     */
    setContext(context: FlagEvaluationContext): void {
        this.#context = context;
    }

    /**
     * Subscribe to flag-set changes. The handler is called each time
     * {@link replace} swaps the flag set.
     *
     * @param handler - the callback to invoke on every flag-set change
     * @returns a function that removes the subscription
     */
    onChange(handler: FlagsChangeHandler): () => void {
        this.#handlers.add(handler);

        return () => {
            this.#handlers.delete(handler);
        };
    }

    /**
     * Swap the entire flag set and notify all registered change handlers.
     *
     * This is the seam a remote-refresh adapter or a test uses to push a new
     * flag set into a live application without reloading the page.
     *
     * @param flags - the replacement flag set
     */
    replace(flags: Readonly<Record<string, FlagValue>>): void {
        this.#flags = flags;

        for (const handler of this.#handlers) {
            handler();
        }
    }

    /**
     * The stored evaluation context. Read by a migration layer when handing off
     * to a remote provider that takes context at initialisation time.
     *
     * @returns the current evaluation context
     */
    get context(): FlagEvaluationContext {
        return this.#context;
    }
}
