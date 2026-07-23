/**
 * HTTP client port.
 *
 * Modules depend on this contract, never on a concrete transport. The
 * production adapter is {@link FetchHttpClient}; tests substitute an in-memory
 * fake.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/** The set of HTTP methods supported by the client. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A flat record of URL query parameter values; undefined entries are omitted.
 */
export type QueryParameters = Readonly<Record<string, string | number | boolean | undefined>>;

/** Per-request options forwarded to every HTTP method. */
export interface HttpRequestOptions {
    /** Query parameters appended to the request URL. */
    readonly query?: QueryParameters;

    /** Extra request headers, merged over the client defaults. */
    readonly headers?: Readonly<Record<string, string>>;

    /** Abort signal that cancels the request when it fires. */
    readonly signal?: AbortSignal;

    /** Whether a 401 response may trigger the unauthorized handler (token refresh). Defaults to true. Set false on the refresh request itself so a failed refresh cannot recurse back into the handler. */
    readonly retryOnUnauthorized?: boolean;

    /** Whether this request's failures are reported to the global response-error handler. Defaults to true. Set false for requests that handle their own errors, such as forms surfacing 422s inline or background polls that fail silently. */
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

    /** The resolved request headers. */
    readonly headers: Readonly<Record<string, string>>;

    /** The request body, before serialisation. */
    readonly body: unknown;
}

/**
 * Transform an outgoing request before it is sent. Interceptors run in
 * registration order; each receives the previous interceptor's output.
 */
export type RequestInterceptor = (request: HttpRequest) => HttpRequest | Promise<HttpRequest>;

/**
 * Invoked when a request fails with 401. Return true to retry the request once
 * (e.g. after a successful token refresh).
 */
export type UnauthorizedHandler = () => Promise<boolean>;

/**
 * Invoked whenever a request ultimately fails, whether with an
 * {@link HttpError} (non-2xx response) or a {@link NetworkError} (no response).
 * This is the global seam for surfacing unexpected failures, e.g. a toast
 * notification or an error-reporting call; per-request opt-out is via
 * {@link HttpRequestOptions.notifyOnError}. Filtering out expected failures
 * such as {@link HttpValidationError} is left to the handler, since it receives
 * every failure.
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
     * @param options - optional query parameters, headers, and abort signal
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
     * @param options - optional query parameters, headers, and abort signal
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
     * @param options - optional query parameters, headers, and abort signal
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
     * @param options - optional query parameters, headers, and abort signal
     * @returns the parsed response body
     * @throws {@link HttpError} when the server returns a non-2xx status
     * @throws {@link NetworkError} when the request cannot reach the server
     */
    patch<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T>;

    /**
     * Send a DELETE request.
     *
     * @param path - the API path, relative to the client's base URL
     * @param options - optional query parameters, headers, and abort signal
     * @returns the parsed response body
     * @throws {@link HttpError} when the server returns a non-2xx status
     * @throws {@link NetworkError} when the request cannot reach the server
     */
    delete<T>(path: string, options?: HttpRequestOptions): Promise<T>;

    /**
     * Download a response body as a Blob, for binary or file responses.
     *
     * @param path - the API path, relative to the client's base URL
     * @param options - optional query parameters, headers, and abort signal
     * @returns the response body as a Blob
     * @throws {@link HttpError} when the server returns a non-2xx status
     * @throws {@link NetworkError} when the request cannot reach the server
     */
    download(path: string, options?: HttpRequestOptions): Promise<Blob>;
}
