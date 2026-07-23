/**
 * Environment source that consults an ordered chain of sources.
 *
 * The first source that defines a key wins. The bootstrap chains the runtime
 * environment document ahead of Vite's build variables, so a deployed value
 * always beats a local development default.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { EnvironmentSource } from './environment';

/**
 * Read environment values from the first source in the chain that defines them.
 */
export class ChainEnvironmentSource implements EnvironmentSource {
    /** The ordered chain of sources consulted in turn. */
    readonly #sources: readonly EnvironmentSource[];

    constructor(sources: readonly EnvironmentSource[]) {
        this.#sources = sources;
    }

    /**
     * Return the value from the first source in the chain that defines `key`.
     *
     * @param key - the environment variable name
     * @returns the first defined value, or undefined when no source defines it
     */
    get(key: string): string | undefined {
        for (const source of this.#sources) {
            const value = source.get(key);

            if (value !== undefined) {
                return value;
            }
        }

        return undefined;
    }
}
