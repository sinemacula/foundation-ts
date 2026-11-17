/**
 * Error reporter port that vendor SDK adapters implement.
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
     * Record a thrown value with optional structured context.
     */
    captureError(error: unknown, context?: Readonly<Record<string, unknown>>): void;

    /**
     * Record a diagnostic message with optional structured context.
     */
    captureMessage(message: string, context?: Readonly<Record<string, unknown>>): void;

    /**
     * Set or clear the authenticated user identity for subsequent reports.
     *
     * @param user - the user to associate, or null to clear the identity
     */
    setUser(user: ReportedUser | null): void;
}
