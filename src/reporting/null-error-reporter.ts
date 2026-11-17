/**
 * No-op error reporter, the default when no provider is configured.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { ErrorReporter, ReportedUser } from './error-reporter';

/**
 * An error reporter that discards every report without side effects.
 */
export class NullErrorReporter implements ErrorReporter {
    /**
     * Discard the error.
     */
    captureError(_error: unknown, _context?: Readonly<Record<string, unknown>>): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the message.
     */
    captureMessage(_message: string, _context?: Readonly<Record<string, unknown>>): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the user.
     */
    setUser(_user: ReportedUser | null): void {
        // Intentionally empty: no provider is configured.
    }
}
