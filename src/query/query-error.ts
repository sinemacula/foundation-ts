/**
 * Error type for the query layer.
 *
 * Raised when a wire-format response does not match the expected envelope
 * shape, when a caller asks to sort by a column the definition does not allow,
 * or when a builder call asks for a query the toolkit would refuse (an empty
 * logical group, random order under cursor pagination). Callers branch on
 * `instanceof` to separate a query-layer fault from a transport or validation
 * error.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A query-layer operation received malformed data or an unsupported argument.
 */
export class QueryError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'QueryError';
    }
}
