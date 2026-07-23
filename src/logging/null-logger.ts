/**
 * No-op logger adapter.
 *
 * Used as the default when no logging provider is configured. All methods are
 * intentionally empty so that calls are silently ignored rather than throwing
 * or writing to the console.
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
     * Discard the entry; the null logger writes nothing.
     */
    debug(_message: string, _fields?: LogFields): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the entry; the null logger writes nothing.
     */
    info(_message: string, _fields?: LogFields): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the entry; the null logger writes nothing.
     */
    warn(_message: string, _fields?: LogFields): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the entry; the null logger writes nothing.
     */
    error(_message: string, _fields?: LogFields): void {
        // Intentionally empty: no provider is configured.
    }
}
