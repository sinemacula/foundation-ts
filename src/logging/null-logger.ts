/**
 * No-op logger, the default when no provider is configured.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { LogFields, Logger } from './logger';

/**
 * A logger that discards every entry without side effects.
 */
export class NullLogger implements Logger {
    /**
     * Discard the entry.
     */
    debug(_message: string, _fields?: LogFields): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the entry.
     */
    info(_message: string, _fields?: LogFields): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the entry.
     */
    warn(_message: string, _fields?: LogFields): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the entry.
     */
    error(_message: string, _fields?: LogFields): void {
        // Intentionally empty: no provider is configured.
    }
}
