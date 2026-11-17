/**
 * Feature-flag port that provider SDK adapters implement.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A scalar value that a feature flag can hold.
 */
export type FlagValue = boolean | string | number;

/**
 * Attributes forwarded to targeting-capable adapters for per-user or
 * per-organisation flag evaluation.
 */
export type FlagEvaluationContext = Readonly<Record<string, string | number | boolean>>;

/**
 * Callback invoked after the active flag set changes.
 */
export type FlagsChangeHandler = () => void;

/**
 * Contract that every feature-flag adapter must satisfy.
 */
export interface FeatureFlags {
    /**
     * Resolve a boolean flag; non-boolean or missing values resolve to the
     * fallback.
     *
     * @param fallback - defaults to `false`
     */
    isEnabled(key: string, fallback?: boolean): boolean;

    /**
     * Resolve a variant flag. A value whose runtime type differs from the
     * fallback, or a missing key, resolves to the fallback.
     *
     * @param fallback - its type pins the return type
     */
    variant<Value extends FlagValue>(key: string, fallback: Value): Value;

    /**
     * Set the user/org attributes that targeting adapters evaluate flags
     * against, typically once the user has authenticated.
     */
    setContext(context: FlagEvaluationContext): void;

    /**
     * Subscribe to flag-set changes; the handler runs synchronously after each
     * change.
     *
     * @returns an unsubscribe function
     */
    onChange(handler: FlagsChangeHandler): () => void;
}
