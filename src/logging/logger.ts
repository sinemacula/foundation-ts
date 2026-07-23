/**
 * Logger port.
 *
 * The sanctioned logging seam: application code never calls `console.*`
 * directly, it depends only on this port so that the provider (console locally,
 * a shipping sink later) can be swapped, stubbed in tests, or silenced without
 * touching call sites. Structured fields survive into whichever sink is wired
 * up.
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
     *
     * @param message - the human-readable message
     * @param fields - structured key-value pairs to attach to the entry
     */
    debug(message: string, fields?: LogFields): void;

    /**
     * Record a routine, informational event.
     *
     * @param message - the human-readable message
     * @param fields - structured key-value pairs to attach to the entry
     */
    info(message: string, fields?: LogFields): void;

    /**
     * Record an unexpected but recoverable condition.
     *
     * @param message - the human-readable message
     * @param fields - structured key-value pairs to attach to the entry
     */
    warn(message: string, fields?: LogFields): void;

    /**
     * Record a failure.
     *
     * @param message - the human-readable message
     * @param fields - structured key-value pairs to attach to the entry
     */
    error(message: string, fields?: LogFields): void;
}
