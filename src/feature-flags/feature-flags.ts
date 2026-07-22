/**
 * Feature-flag port.
 *
 * Provider SDKs (LaunchDarkly, PostHog, Flagsmith, Unleash, …) are adapters
 * that implement this interface. The application never imports a provider SDK
 * directly - it depends only on this port so that the provider can be swapped,
 * stubbed in tests, or replaced without touching application code.
 *
 * A config-driven {@link StaticFeatureFlags} adapter ships out of the box and
 * reads flags from the runtime environment document. A remote provider becomes
 * an adapter behind this interface without any app-layer changes.
 *
 * Evaluation context: call {@link FeatureFlags.setContext} after a user
 * authenticates to forward user/org attributes to targeting-capable adapters.
 * The static adapter stores the context for handoff; apps must not hard-wire
 * this call to the auth flow - wire it from a dedicated context-sync layer so
 * coupling stays unidirectional.
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
 * Callback invoked when the active flag set changes (e.g. after a remote
 * refresh or a test-driven {@link StaticFeatureFlags.replace} call).
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
     * @param key - the flag key to look up
     * @param fallback - the value returned when the flag is absent or
     * non-boolean; defaults to `false`
     * @returns the resolved boolean value, or the fallback
     */
    isEnabled(key: string, fallback?: boolean): boolean;

    /**
     * Resolve a variant flag. A value whose runtime type differs from the
     * fallback, or a missing key, resolves to the fallback.
     *
     * @param key - the flag key to look up
     * @param fallback - the value returned when the flag is absent or the wrong
     * type; its type pins the return type
     * @returns the resolved value, or the fallback
     */
    variant<Value extends FlagValue>(key: string, fallback: Value): Value;

    /**
     * Set the evaluation context (user/org attributes). Targeting adapters use
     * it immediately; the static adapter stores it for handoff to a future
     * provider.
     *
     * @param context - the attribute map to forward
     */
    setContext(context: FlagEvaluationContext): void;

    /**
     * Subscribe to flag-set changes (e.g. a remote refresh). The handler is
     * called synchronously on the main thread after each change.
     *
     * @param handler - the callback to invoke on every change
     * @returns a function that removes the subscription
     */
    onChange(handler: FlagsChangeHandler): () => void;
}
