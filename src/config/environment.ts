/**
 * Environment source port and a typed, fallback-aware reader over it.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

const TRUTHY_VALUES = ['1', 'true', 'yes', 'on'];

const DECIMAL_INTEGER = /^-?\d+$/u;

/**
 * A read-only provider of raw environment values.
 */
export interface EnvironmentSource {
    /**
     * Resolve the raw string value for `key`.
     *
     * @param key - the environment variable name
     * @returns the raw value, or undefined when the source does not define it
     */
    get(key: string): string | undefined;
}

/**
 * Typed reader over an {@link EnvironmentSource}. An empty string counts as not
 * set, so every reader resolves it to the fallback.
 */
export class Environment {
    /** The backing source of raw environment values. */
    readonly #source: EnvironmentSource;

    constructor(source: EnvironmentSource) {
        this.#source = source;
    }

    /**
     * Read a string value.
     *
     * @param key - the environment variable name
     * @param fallback - the value returned when the variable is not set
     */
    string(key: string, fallback: string): string;
    string(key: string, fallback?: string): string | undefined;
    string(key: string, fallback?: string): string | undefined {
        return this.#read(key) ?? fallback;
    }

    /**
     * Read a boolean value. The strings `1`, `true`, `yes` and `on` (in any
     * casing) are truthy; every other set value is falsy.
     *
     * @param key - the environment variable name
     * @param fallback - the value returned when the variable is not set
     */
    boolean(key: string, fallback: boolean): boolean;
    boolean(key: string, fallback?: boolean): boolean | undefined;
    boolean(key: string, fallback?: boolean): boolean | undefined {
        const value = this.#read(key);

        if (value === undefined) {
            return fallback;
        }

        return TRUTHY_VALUES.includes(value.toLowerCase());
    }

    /**
     * Read an integer value. Only an optionally negative run of decimal digits
     * within the safe integer range parses; anything else, including padding,
     * signs other than `-`, exponents and separators, resolves to the fallback.
     *
     * @param key - the environment variable name
     * @param fallback - the value returned when the variable is not set or
     * invalid
     */
    integer(key: string, fallback: number): number;
    integer(key: string, fallback?: number): number | undefined;
    integer(key: string, fallback?: number): number | undefined {
        const value = this.#read(key);

        if (value === undefined || !DECIMAL_INTEGER.test(value)) {
            return fallback;
        }

        const parsed = Number(value);

        return Number.isSafeInteger(parsed) ? parsed : fallback;
    }

    /**
     * Read a JSON-encoded value. Values that fail to parse resolve to the
     * fallback.
     *
     * @param key - the environment variable name
     * @param fallback - the value returned when the variable is not set or
     * invalid
     */
    json<T>(key: string, fallback: T): T;
    json<T>(key: string, fallback?: T): T | undefined;
    json<T>(key: string, fallback?: T): T | undefined {
        const value = this.#read(key);

        if (value === undefined) {
            return fallback;
        }

        try {
            // T is caller-declared; the parsed value is not validated.
            return JSON.parse(value) as T;
        } catch {
            return fallback;
        }
    }

    /**
     * Read the raw value for `key`, treating an empty string as not set.
     */
    #read(key: string): string | undefined {
        const value = this.#source.get(key);

        return value === '' ? undefined : value;
    }
}
