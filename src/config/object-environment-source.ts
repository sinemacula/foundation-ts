/**
 * Environment source backed by a plain object.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { EnvironmentSource } from './environment';

/**
 * Read environment values from an in-memory record.
 */
export class ObjectEnvironmentSource implements EnvironmentSource {
    /** The backing record of environment values. */
    readonly #values: Readonly<Record<string, string>>;

    constructor(values: Readonly<Record<string, string>>) {
        this.#values = values;
    }

    /**
     * Read `key` from the record's own properties, or undefined when it is
     * absent or only inherited.
     */
    get(key: string): string | undefined {
        return Object.hasOwn(this.#values, key) ? this.#values[key] : undefined;
    }
}
