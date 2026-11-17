/**
 * Error type for the realtime layer.
 *
 * Raised when a connection cannot be opened, or when an operation is attempted
 * against a connection that cannot service it, such as sending on a socket that
 * is not open. Callers branch on `instanceof` rather than inspecting raw
 * transport internals.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A realtime connection could not be opened or could not service an operation.
 */
export class RealtimeError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'RealtimeError';
    }
}
