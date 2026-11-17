/**
 * Error type for the realtime layer.
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
