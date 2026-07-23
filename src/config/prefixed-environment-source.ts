/**
 * Environment source that maps unprefixed keys onto a prefixed record.
 *
 * Local development reads Vite's `import.meta.env`, whose keys carry the
 * `VITE_` prefix. Wrapping that record here lets configuration definitions use
 * canonical, deployment-style names (`API_URL`) everywhere.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { EnvironmentSource } from './environment';

/**
 * Read environment values from a record whose keys carry a fixed prefix.
 */
export class PrefixedEnvironmentSource implements EnvironmentSource {
    /** The backing record whose keys carry the prefix. */
    readonly #values: Readonly<Record<string, unknown>>;

    /** The fixed prefix carried by every key in the record. */
    readonly #prefix: string;

    constructor(values: Readonly<Record<string, unknown>>, prefix: string) {
        this.#values = values;
        this.#prefix = prefix;
    }

    /**
     * Look `key` up under its prefixed name, discarding non-string values.
     *
     * @param key - the unprefixed environment variable name
     * @returns the prefixed value when it is a string, otherwise undefined
     */
    get(key: string): string | undefined {
        const value = this.#values[`${this.#prefix}${key}`];

        return typeof value === 'string' ? value : undefined;
    }
}
