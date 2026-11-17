/**
 * The HTTP client port modules depend on instead of a concrete transport.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/** The HTTP methods the client sends. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A flat record of URL query parameter values; undefined entries are omitted.
 */
export type QueryParameters = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * Whether a request sends credentials such as cookies: never, to its own origin
 * only, or to any origin.
 */
export type HttpCredentialsMode = 'omit' | 'same-origin' | 'include';

/** Per-request options forwarded to every HTTP method. */
export interface HttpRequestOptions {
    /** Query parameters appended to the request URL. */
    readonly query?: QueryParameters;

    /** Extra request headers, merged over the client defaults; names are compared case-insensitively. */
    readonly headers?: Readonly<Record<string, string>>;

    /** Abort signal that cancels the request when it fires, including while it waits on an interceptor or the unauthorized handler. */
    readonly signal?: AbortSignal;

    /** Whether credentials such as cookies are sent; omit for the platform default (same-origin in browsers). */
    readonly credentials?: HttpCredentialsMode;

    /** Whether a 401 may trigger the unauthorized handler. Defaults to true; set false on every request the refresh itself makes, or its 401 waits on the refresh forever. */
    readonly retryOnUnauthorized?: boolean;

    /** Whether this request's failures reach the response-error handler. Defaults to true; set false for requests that handle their own errors. */
    readonly notifyOnError?: boolean;
}

/**
 * A fully-resolved outgoing request, as seen by request interceptors.
 */
export interface HttpRequest {
    /** The HTTP method to send. */
    readonly method: HttpMethod;

    /** The absolute request URL. */
    readonly url: string;

    /** The resolved request headers, keyed by lower-case name. */
    readonly headers: Readonly<Record<string, string>>;

    /** The request body, before serialisation. */
    readonly body: unknown;

    /** Whether credentials such as cookies are sent, or undefined for the platform default. */
    readonly credentials?: HttpCredentialsMode;
}

/**
 * Transform an outgoing request before it is sent. Interceptors run in
 * registration order; each receives the previous interceptor's output.
 */
export type RequestInterceptor = (request: HttpRequest) => HttpRequest | Promise<HttpRequest>;

/**
 * Invoked when a request fails with 401, at most once per call. Return true to
 * retry the request once (e.g. after a successful token refresh). It receives
 * the request that received the 401, so a handler can retry without refreshing
 * when that request's credentials are already out of date. Requests the handler
 * makes itself must set {@link HttpRequestOptions.retryOnUnauthorized} to
 * false, or their 401 waits on the handler forever.
 */
export type UnauthorizedHandler = (request: HttpRequest) => Promise<boolean>;

/**
 * Invoked once with the final failure of a request, after any retries: an
 * {@link HttpError}, a {@link NetworkError} (including a {@link TimeoutError})
 * or a {@link ResponseParseError}, never a {@link CancelledError}. Expected
 * failures such as an {@link HttpValidationError} arrive too and are the
 * handler's to filter; a request opts out with
 * {@link HttpRequestOptions.notifyOnError}.
 */
export type ResponseErrorHandler = (error: unknown, request: HttpRequest) => void;

/**
 * A typed, JSON-first HTTP client.
 */
export interface HttpClient {
    /**
     * Send a GET request.
     *
     * @param path - the API path, relative to the client's base URL
     * @returns the parsed response body
     * @throws {@link HttpError} when the server returns a non-2xx status
     * @throws {@link NetworkError} when the request cannot reach the server
     */
    get<T>(path: string, options?: HttpRequestOptions): Promise<T>;

    /**
     * Send a POST request.
     *
     * @param path - the API path, relative to the client's base URL
     * @param body - the request body; a FormData or Blob instance is sent
     * unchanged for uploads, any other value is serialised to JSON
     * @returns the parsed response body
     * @throws {@link HttpError} when the server returns a non-2xx status
     * @throws {@link NetworkError} when the request cannot reach the server
     */
    post<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T>;

    /**
     * Send a PUT request.
     *
     * @param path - the API path, relative to the client's base URL
     * @param body - the request body; a FormData or Blob instance is sent
     * unchanged for uploads, any other value is serialised to JSON
     * @returns the parsed response body
     * @throws {@link HttpError} when the server returns a non-2xx status
     * @throws {@link NetworkError} when the request cannot reach the server
     */
    put<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T>;

    /**
     * Send a PATCH request.
     *
     * @param path - the API path, relative to the client's base URL
     * @param body - the request body; a FormData or Blob instance is sent
     * unchanged for uploads, any other value is serialised to JSON
     * @returns the parsed response body
     * @throws {@link HttpError} when the server returns a non-2xx status
     * @throws {@link NetworkError} when the request cannot reach the server
     */
    patch<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T>;

    /**
     * Send a DELETE request.
     *
     * @param path - the API path, relative to the client's base URL
     * @returns the parsed response body
     * @throws {@link HttpError} when the server returns a non-2xx status
     * @throws {@link NetworkError} when the request cannot reach the server
     */
    delete<T>(path: string, options?: HttpRequestOptions): Promise<T>;

    /**
     * Download a response body as a Blob, for binary or file responses.
     *
     * @param path - the API path, relative to the client's base URL
     * @returns the response body as a Blob
     * @throws {@link HttpError} when the server returns a non-2xx status
     * @throws {@link NetworkError} when the request cannot reach the server
     */
    download(path: string, options?: HttpRequestOptions): Promise<Blob>;
}
