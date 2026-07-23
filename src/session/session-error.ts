/**
 * Error type for the session layer.
 *
 * Thrown when a session or user response cannot be normalised - the envelope is
 * missing, or a required token or identifier field is absent or the wrong type
 * - so a malformed payload surfaces as a typed failure callers can branch on
 * with `instanceof` rather than a bare `Error`.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A session or user response that did not match the expected shape.
 */
export class SessionError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'SessionError';
    }
}
