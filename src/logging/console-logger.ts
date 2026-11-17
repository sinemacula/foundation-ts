/**
 * Development logger that writes to the console.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { LogFields, Logger, LogLevel } from './logger';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

/**
 * A logger that writes to the console, dropping entries below a minimum level.
 *
 * `debug` writes via `console.info` because `console.debug` is lint-banned.
 */
export class ConsoleLogger implements Logger {
    /** The lowest level written to the console. */
    readonly #minimumLevel: LogLevel;

    /**
     * Create a logger that drops entries below `minimumLevel`.
     *
     * @param minimumLevel - the lowest level written (default 'debug')
     */
    constructor(minimumLevel: LogLevel = 'debug') {
        this.#minimumLevel = minimumLevel;
    }

    /**
     * Write a debug entry through `console.info` when the level is enabled.
     */
    debug(message: string, fields?: LogFields): void {
        this.#write('debug', console.info, message, fields);
    }

    /**
     * Write an info entry through `console.info` when the level is enabled.
     */
    info(message: string, fields?: LogFields): void {
        this.#write('info', console.info, message, fields);
    }

    /**
     * Write a warning entry through `console.warn` when the level is enabled.
     */
    warn(message: string, fields?: LogFields): void {
        this.#write('warn', console.warn, message, fields);
    }

    /**
     * Write an error entry through `console.error` when the level is enabled.
     */
    error(message: string, fields?: LogFields): void {
        this.#write('error', console.error, message, fields);
    }

    /**
     * Write an entry to `sink` unless its level is below the minimum.
     *
     * @param sink - the console method to write through
     */
    #write(level: LogLevel, sink: (...args: unknown[]) => void, message: string, fields?: LogFields): void {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#minimumLevel]) {
            return;
        }

        sink(`[Logger:${level}]`, message, ...(fields !== undefined ? [fields] : []));
    }
}
