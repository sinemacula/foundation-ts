/**
 * Error type for the query layer.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A query-layer operation received malformed data or an unsupported argument,
 * such as a response off the envelope shape, a sort column the definition does
 * not allow, or a query the toolkit would refuse.
 */
export class QueryError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'QueryError';
    }
}
