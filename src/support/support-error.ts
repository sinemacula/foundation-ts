/**
 * Error type for the support layer.
 *
 * Thrown when a support primitive is used outside its required lifecycle, such
 * as resolving a service holder before an instance has been installed, so a
 * programming mistake surfaces as a typed failure callers can branch on with
 * `instanceof` rather than a bare `Error`.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A support primitive used outside its required lifecycle.
 */
export class SupportError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'SupportError';
    }
}
