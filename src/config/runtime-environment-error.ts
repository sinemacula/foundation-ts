/**
 * Error type for the runtime environment document.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * The runtime environment document could not be loaded or is malformed.
 */
export class RuntimeEnvironmentError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'RuntimeEnvironmentError';
    }
}
