/**
 * Console error reporter adapter.
 *
 * Writes errors and messages to the browser console for use during development.
 * Not intended for production - swap in a real provider adapter via the
 * ErrorReporter port when deploying.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { ErrorReporter, ReportedUser } from './error-reporter';

/**
 * An error reporter that writes to the browser console.
 *
 * `captureError` uses `console.error`, `captureMessage` uses `console.warn`,
 * and `setUser` is a no-op (user identity is not relevant in the console).
 */
export class ConsoleErrorReporter implements ErrorReporter {
    /**
     * Write the error and its context to the console via `console.error`.
     */
    captureError(error: unknown, context?: Readonly<Record<string, unknown>>): void {
        console.error('[ErrorReporter]', error, ...(context !== undefined ? [context] : []));
    }

    /**
     * Write the message and its context to the console via `console.warn`.
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
