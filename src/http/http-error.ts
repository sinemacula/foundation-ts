/**
 * The HTTP layer's error hierarchy, which callers branch on with `instanceof`.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * The internal error codes the API error envelope carries in `error.code`.
 */
export const ApiErrorCode = {
    UnhandledError: 10001,
    BadRequest: 10100,
    Unauthenticated: 10101,
    Forbidden: 10102,
    NotFound: 10103,
    NotAllowed: 10104,
    TokenMismatch: 10105,
    InvalidInput: 10106,
    TooManyRequests: 10107,
    Conflict: 10108,
    Gone: 10109,
    PayloadTooLarge: 10110,
    Locked: 10111,
    ServiceUnavailable: 10112,
    HttpError: 10113,
    PreconditionFailed: 10114,
    PreconditionRequired: 10115,
    UnsupportedMediaType: 10116,
    MaintenanceMode: 10200,
    QueryTooExpensive: 10201,
    RefreshCookieMissing: 10202,
} as const;

/** One of the known {@link ApiErrorCode} values. */
export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/**
 * The request never produced a usable response: DNS failure, refused
 * connection, or a connection reset while the body was being read.
 */
export class NetworkError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'NetworkError';
    }
}

/**
 * The configured request timeout elapsed before the response body was fully
 * read; a transport failure like any other {@link NetworkError}.
 */
export class TimeoutError extends NetworkError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'TimeoutError';
    }
}

/**
 * The caller's `AbortSignal` fired, during the request, while its body was
 * read, or during a retry backoff.
 */
export class CancelledError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'CancelledError';
    }
}

/**
 * A success response declared a JSON body that does not parse, such as an HTML
 * page served with a JSON content type.
 */
export class ResponseParseError extends Error {
    /** The HTTP status code of the response. */
    readonly status: number;

    constructor(status: number, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'ResponseParseError';
        this.status = status;
    }
}

/**
 * The API error envelope's identifying fields, when the body carried them.
 */
export interface HttpErrorDetails {
    /** The API's internal error code, such as {@link ApiErrorCode.NotFound}. */
    readonly code?: number | null;

    /** The API's short, human-readable error title. */
    readonly title?: string | null;
}

/**
 * The server responded with a non-success status.
 */
export class HttpError extends Error {
    /** The HTTP status code of the response. */
    readonly status: number;

    /** The parsed error response body, or null. */
    readonly payload: unknown;

    /** The API's internal error code, or null when the body did not carry one. */
    readonly code: number | null;

    /** The API's error title, or null when the body did not carry one. */
    readonly title: string | null;

    constructor(status: number, message: string, payload: unknown = null, details: HttpErrorDetails = {}) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.payload = payload;
        this.code = details.code ?? null;
        this.title = details.title ?? null;
    }
}

/**
 * The server rejected the request input with per-field errors. Field keys are
 * the dotted positions of the offending input, such as `email`,
 * `order.created_at` or `filters.name.$eq`.
 */
export class HttpValidationError extends HttpError {
    /** The per-field validation messages. */
    readonly errors: Readonly<Record<string, readonly string[]>>;

    constructor(
        status: number,
        message: string,
        payload: unknown,
        errors: Record<string, readonly string[]>,
        details: HttpErrorDetails = {},
    ) {
        super(status, message, payload, details);
        this.name = 'HttpValidationError';
        this.errors = errors;
    }
}

/**
 * Which query cost cap a request exceeded, and by how much.
 */
export interface QueryTooExpensiveMeta {
    /** The query parameter that exceeded the cap, such as `filters`. */
    readonly parameter: string;

    /** The position within the parameter that exceeded the cap. */
    readonly pointer: string;

    /** The machine-readable cap that was exceeded. */
    readonly reason: string;

    /** The cap's limit. */
    readonly limit: number;

    /** The value the request reached. */
    readonly actual: number;
}

/**
 * A well-formed query exceeded one of the API's cost caps (filter size, nesting
 * depth, page size and the like); narrowing the query is the only fix.
 */
export class QueryTooExpensiveError extends HttpError {
    /** The cap that was exceeded. */
    readonly meta: QueryTooExpensiveMeta;

    constructor(
        status: number,
        message: string,
        payload: unknown,
        meta: QueryTooExpensiveMeta,
        details: HttpErrorDetails = {},
    ) {
        super(status, message, payload, details);
        this.name = 'QueryTooExpensiveError';
        this.meta = meta;
    }
}

/**
 * The API is down for maintenance; distinct from an ordinary 503 so a UI can
 * show a maintenance state.
 */
export class MaintenanceError extends HttpError {
    constructor(status: number, message: string, payload: unknown, details: HttpErrorDetails = {}) {
        super(status, message, payload, details);
        this.name = 'MaintenanceError';
    }
}
