/**
 * No-op error reporter adapter.
 *
 * Used as the default when no error-reporting provider is configured. All
 * methods are intentionally empty so that calls are silently ignored rather
 * than throwing or logging.
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
     * Discard the error; the null reporter records nothing.
     */
    captureError(_error: unknown, _context?: Readonly<Record<string, unknown>>): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the message; the null reporter records nothing.
     */
    captureMessage(_message: string, _context?: Readonly<Record<string, unknown>>): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the user; the null reporter records nothing.
     */
    setUser(_user: ReportedUser | null): void {
        // Intentionally empty: no provider is configured.
    }
}
