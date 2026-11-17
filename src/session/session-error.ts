/**
 * Error for a malformed session response, user response or persisted snapshot.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A session payload that did not match the expected shape.
 */
export class SessionError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'SessionError';
    }
}
