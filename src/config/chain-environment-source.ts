/**
 * Environment source that consults an ordered chain of sources.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { EnvironmentSource } from './environment';

/**
 * Read environment values from the first source in the chain that sets them. An
 * empty string counts as not set, so it falls through to later sources.
 */
export class ChainEnvironmentSource implements EnvironmentSource {
    /** The ordered chain of sources consulted in turn. */
    readonly #sources: readonly EnvironmentSource[];

    constructor(sources: readonly EnvironmentSource[]) {
        this.#sources = sources;
    }

    /**
     * Return the value from the first source in the chain that sets `key`.
     *
     * @returns the first non-empty value, or undefined when no source sets it
     */
    get(key: string): string | undefined {
        for (const source of this.#sources) {
            const value = source.get(key);

            if (value !== undefined && value !== '') {
                return value;
            }
        }

        return undefined;
    }
}
