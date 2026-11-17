/**
 * Logger port; application code logs through it instead of `console.*`.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Severity of a log entry, ordered `debug` < `info` < `warn` < `error`.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured key-value pairs attached to a log entry.
 */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Contract that every logging adapter must satisfy.
 */
export interface Logger {
    /**
     * Record a diagnostic message useful only during development.
     */
    debug(message: string, fields?: LogFields): void;

    /**
     * Record a routine, informational event.
     */
    info(message: string, fields?: LogFields): void;

    /**
     * Record an unexpected but recoverable condition.
     */
    warn(message: string, fields?: LogFields): void;

    /**
     * Record a failure.
     */
    error(message: string, fields?: LogFields): void;
}
