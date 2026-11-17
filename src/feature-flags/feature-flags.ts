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
     * Resolve a string variant flag. A value whose runtime type differs from
     * the fallback, or a missing key, resolves to the fallback.
     */
    variant(key: string, fallback: string): string;

    /**
     * Resolve a numeric variant flag. A value whose runtime type differs from
     * the fallback, or a missing key, resolves to the fallback.
     */
    variant(key: string, fallback: number): number;

    /**
     * Resolve a boolean variant flag. A value whose runtime type differs from
     * the fallback, or a missing key, resolves to the fallback.
     *
     * @imperative
     */
    variant(key: string, fallback: boolean): boolean;

    /**
     * Resolve a variant flag narrowed to an explicit `Value`. The narrowing is
     * an unchecked assertion: only the runtime type is compared with the
     * fallback's, never membership of `Value`.
     */
    variant<Value extends FlagValue = FlagValue>(key: string, fallback: NoInfer<Value>): NoInfer<Value>;

    /**
     * Set the user/org attributes that targeting adapters evaluate flags
     * against, typically once the user has authenticated.
     */
    setContext(context: FlagEvaluationContext): void;

    /**
     * Subscribe to flag-set changes; the handler runs synchronously after each
     * change. A synchronously throwing handler neither stops the others nor
     * propagates to whoever made the change.
     *
     * @returns an unsubscribe function
     */
    onChange(handler: FlagsChangeHandler): () => void;
}
