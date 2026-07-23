/**
 * Error hierarchy for the HTTP layer.
 *
 * `NetworkError` covers transport failures (no response was received).
 * `CancelledError` covers a deliberate abort (a caller signal or a configured
 * timeout), so it never gets confused with a genuine transport failure.
 * `HttpError` covers non-2xx responses, and `HttpValidationError` narrows 422
 * responses that carry a field-error map. Callers branch on `instanceof` and
 * never inspect raw fetch internals.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * The request never produced a response (DNS failure, refused connection).
 */
export class NetworkError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'NetworkError';
    }
}

/**
 * The request was deliberately cancelled - the caller's `AbortSignal` fired, or
 * the effective signal (which may compose a caller signal with a configured
 * timeout) reports aborted - rather than the transport genuinely failing. UIs
 * generally suppress error handling for this type entirely; it composes with
 * {@link useResource}, which already swallows a run's own signal-abort
 * rejection instead of surfacing it as `error`. Unlike {@link NetworkError},
 * this is never passed to the global response-error handler and is never
 * retried.
 */
export class CancelledError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'CancelledError';
    }
}

/**
 * The server responded with a non-success status.
 */
export class HttpError extends Error {
    /** The HTTP status code of the response. */
    readonly status: number;

    /** The parsed error response body, or null. */
    readonly payload: unknown;

    constructor(status: number, message: string, payload: unknown = null) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.payload = payload;
    }
}

/**
 * The server rejected the request payload (422) with per-field errors.
 */
export class HttpValidationError extends HttpError {
    /** The per-field validation messages. */
    readonly errors: Readonly<Record<string, readonly string[]>>;

    constructor(status: number, message: string, payload: unknown, errors: Record<string, readonly string[]>) {
        super(status, message, payload);
        this.name = 'HttpValidationError';
        this.errors = errors;
    }
}
