/**
 * Typed access to environment values.
 *
 * `EnvironmentSource` is the port every concrete source implements (runtime
 * JSON, Vite build variables, plain objects in tests). `Environment` wraps a
 * source with typed, fallback-aware accessors so configuration definitions
 * never hand-roll string coercion.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

const TRUTHY_VALUES = ['1', 'true', 'yes', 'on'];

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
 * Typed reader over an {@link EnvironmentSource}.
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
     * @param fallback - the value returned when the variable is not defined
     * @returns the resolved value, or the fallback
     */
    string(key: string): string | undefined;
    string(key: string, fallback: string): string;
    string(key: string, fallback?: string): string | undefined {
        return this.#source.get(key) ?? fallback;
    }

    /**
     * Read a boolean value. The strings `1`, `true`, `yes` and `on` (in any
     * casing) are truthy; every other defined value is falsy.
     *
     * @param key - the environment variable name
     * @param fallback - the value returned when the variable is not defined
     * @returns the resolved value, or the fallback
     */
    boolean(key: string): boolean | undefined;
    boolean(key: string, fallback: boolean): boolean;
    boolean(key: string, fallback?: boolean): boolean | undefined {
        const value = this.#source.get(key);

        if (value === undefined) {
            return fallback;
        }

        return TRUTHY_VALUES.includes(value.toLowerCase());
    }

    /**
     * Read an integer value. Values that do not parse as a base-10 integer
     * resolve to the fallback.
     *
     * @param key - the environment variable name
     * @param fallback - the value returned when the variable is missing or
     * invalid
     * @returns the resolved value, or the fallback
     */
    integer(key: string): number | undefined;
    integer(key: string, fallback: number): number;
    integer(key: string, fallback?: number): number | undefined {
        const value = this.#source.get(key);

        if (value === undefined) {
            return fallback;
        }

        const parsed = Number.parseInt(value, 10);

        return Number.isNaN(parsed) ? fallback : parsed;
    }

    /**
     * Read a JSON-encoded value. Values that fail to parse resolve to the
     * fallback.
     *
     * @param key - the environment variable name
     * @param fallback - the value returned when the variable is missing or
     * invalid
     * @returns the parsed value, or the fallback
     */
    json<T>(key: string): T | undefined;
    json<T>(key: string, fallback: T): T;
    json<T>(key: string, fallback?: T): T | undefined {
        const value = this.#source.get(key);

        if (value === undefined) {
            return fallback;
        }

        try {
            // T is caller-declared over operator-controlled runtime values;
            // invalid JSON already falls back via the catch.
            return JSON.parse(value) as T;
        } catch {
            return fallback;
        }
    }
}
