/**
 * Development error reporter that writes to the console.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { ErrorReporter, ReportedUser } from './error-reporter';

/**
 * An error reporter that writes errors via `console.error` and messages via
 * `console.warn`.
 */
export class ConsoleErrorReporter implements ErrorReporter {
    /**
     * Log the error and its context.
     */
    captureError(error: unknown, context?: Readonly<Record<string, unknown>>): void {
        console.error('[ErrorReporter]', error, ...(context !== undefined ? [context] : []));
    }

    /**
     * Log the message and its context.
     */
    captureMessage(message: string, context?: Readonly<Record<string, unknown>>): void {
        console.warn('[ErrorReporter]', message, ...(context !== undefined ? [context] : []));
    }

    /**
     * Ignore the user; console output carries no identity.
     */
    setUser(_user: ReportedUser | null): void {
        // Intentionally empty: user identity is not surfaced via the console.
    }
}
