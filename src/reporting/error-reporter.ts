/**
 * Error reporter port.
 *
 * Vendor SDKs (Sentry, Bugsnag, Rollbar, …) are adapters that implement this
 * interface. The application never imports a vendor SDK directly - it depends
 * only on this port so that the provider can be swapped, stubbed in tests, or
 * silenced without touching application code.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A user identity to attach to subsequent error reports.
 */
export interface ReportedUser {
    /** The stable unique identifier for the user. */
    readonly id: string;

    /** The user's email address, when known. */
    readonly email?: string;

    /** The user's display name, when known. */
    readonly name?: string;
}

/**
 * Contract that every error-reporting adapter must satisfy.
 */
export interface ErrorReporter {
    /**
     * Record an exception with optional structured context.
     *
     * @param error - the thrown value (may be any type)
     * @param context - additional key-value pairs to attach to the report
     */
    captureError(error: unknown, context?: Readonly<Record<string, unknown>>): void;

    /**
     * Record a diagnostic message with optional structured context.
     *
     * @param message - the human-readable message
     * @param context - additional key-value pairs to attach to the report
     */
    captureMessage(message: string, context?: Readonly<Record<string, unknown>>): void;

    /**
     * Set or clear the authenticated user identity for subsequent reports.
     *
     * @param user - the user to associate, or null to clear the identity
     */
    setUser(user: ReportedUser | null): void;
}
