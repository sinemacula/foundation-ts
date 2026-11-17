/**
 * Environment source that maps unprefixed keys onto a prefixed record.
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
     * Look `key` up among the record's own properties under its prefixed name,
     * discarding inherited and non-string values.
     *
     * @param key - the unprefixed environment variable name
     */
    get(key: string): string | undefined {
        const prefixedKey = `${this.#prefix}${key}`;
        const value = Object.hasOwn(this.#values, prefixedKey) ? this.#values[prefixedKey] : undefined;

        return typeof value === 'string' ? value : undefined;
    }
}
