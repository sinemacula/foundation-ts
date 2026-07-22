/**
 * Fetch-backed adapter for the {@link HttpClient} port.
 *
 * JSON-first: request bodies are serialised to JSON, JSON responses are parsed,
 * and non-success responses are mapped onto the {@link HttpError} hierarchy.
 * FormData and Blob bodies are passed to fetch unchanged for uploads, and
 * {@link FetchHttpClient.download} reads a response as a raw Blob. A single
 * optional unauthorized handler supports refresh-and-retry token flows without
 * coupling this adapter to any auth implementation, and an optional
 * response-error handler is notified of every ultimate failure so an
 * application can surface it globally. A caller abort or a configured timeout
 * rejects with {@link CancelledError} rather than {@link NetworkError} so a
 * deliberate cancel is never confused with a transport failure, and an opt-in
 * `retry` policy re-attempts transient failures on idempotent requests with a
 * backoff delay between attempts.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { ExponentialBackoff } from '../realtime/exponential-backoff';
import { isRecord } from '../support/is-record';
import type {
    HttpClient,
    HttpMethod,
    HttpRequest,
    HttpRequestOptions,
    QueryParameters,
    RequestInterceptor,
    ResponseErrorHandler,
    UnauthorizedHandler,
} from './http-client';
import { CancelledError, HttpError, HttpValidationError, NetworkError } from './http-error';

/**
 * Opt-in transient-retry policy for idempotent requests:
 * {@link FetchHttpClient.get} and {@link FetchHttpClient.download}. POST, PUT,
 * PATCH, and DELETE never retry regardless of this policy, and a
 * {@link CancelledError} is never retried.
 */
export interface FetchHttpClientRetryOptions {
    /** Number of retries attempted after the first try. Defaults to 2. */
    readonly attempts?: number;

    /** Delay strategy between attempts. Defaults to a new {@link ExponentialBackoff}; that class predates this use for realtime reconnect scheduling and may move to a shared support module once both use sites are extracted from this package. */
    readonly backoff?: ExponentialBackoff;
}

/** Construction options for {@link FetchHttpClient}. */
export interface FetchHttpClientOptions {
    /** Base URL that every request path is resolved against. */
    readonly baseUrl: string;

    /** Fetch implementation to use; defaults to the global fetch. */
    readonly fetchFn?: typeof fetch;

    /** Per-request timeout in milliseconds; omit for none. */
    readonly timeout?: number;

    /** Headers sent on every request unless overridden. */
    readonly defaultHeaders?: Readonly<Record<string, string>>;

    /** Interceptors applied to each request in registration order. */
    readonly requestInterceptors?: readonly RequestInterceptor[];

    /** Handler invoked on a 401 to attempt a refresh-and-retry. */
    readonly onUnauthorized?: UnauthorizedHandler;

    /** Invoked whenever a request ultimately fails. This is where an application wires a toast or error-reporting call; per-request `notifyOnError: false` opts a request out. The handler receives every ultimate failure except {@link CancelledError} (a deliberate cancel is never reported), including {@link HttpValidationError}, so filtering expected validation failures is left to the handler. */
    readonly onResponseError?: ResponseErrorHandler;

    /** Opt-in retry policy for transient failures. Omit entirely for a single attempt on every request; see {@link FetchHttpClientRetryOptions}. */
    readonly retry?: FetchHttpClientRetryOptions;
}

/** How a successful response body is read: parsed JSON/text, or a raw Blob. */
type BodyParseMode = 'json' | 'blob';

/** HTTP statuses treated as transient, and therefore retryable, failures. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * Descriptor passed to the private {@link FetchHttpClient.#sendAttempt}
 * dispatch method.
 */
interface SendRequest {
    /** The HTTP method to dispatch. */
    readonly method: HttpMethod;

    /** The request path, relative to the base URL. */
    readonly path: string;

    /** The request body, if any. */
    readonly body: unknown;

    /** The per-request options, if any. */
    readonly options: HttpRequestOptions | undefined;

    /** Whether a 401 may trigger the refresh-and-retry flow. */
    readonly shouldRetryUnauthorized: boolean;

    /** Whether transient failures may be retried. */
    readonly idempotent: boolean;

    /** How the successful response body is read. */
    readonly parse: BodyParseMode;
}

/**
 * Mutable holder for the most recently resolved request, read for final-outcome
 * error notification.
 */
interface AttemptContext {
    /** The most recently resolved request, or null before dispatch. */
    request: HttpRequest | null;
}

/**
 * Outcome of the 401-refresh-and-retry-once flow. A tagged union rather than
 * `T | undefined`, because a legitimately recovered value can itself be
 * `undefined` (an empty response body).
 */
type UnauthorizedRetryResult<T> =
    | {
          /** Marks a recovered outcome. */
          readonly recovered: true;

          /** The value recovered by the retry. */
          readonly value: T;
      }
    | {
          /** Marks a non-recovered outcome. */
          readonly recovered: false;
      };

/**
 * The production {@link HttpClient} adapter, built on the Fetch API.
 */
export class FetchHttpClient implements HttpClient {
    /** The normalised base URL, without a trailing slash. */
    readonly #baseUrl: string;

    /** The fetch implementation used for every dispatch. */
    readonly #fetchFn: typeof fetch;

    /** The per-request timeout in milliseconds, or null. */
    readonly #timeout: number | null;

    /** Headers merged into every request. */
    readonly #defaultHeaders: Readonly<Record<string, string>>;

    /** Interceptors applied to each request in order. */
    readonly #interceptors: readonly RequestInterceptor[];

    /** The 401 refresh handler, or null when unset. */
    readonly #onUnauthorized: UnauthorizedHandler | null;

    /** The response-error handler, or null when unset. */
    readonly #onResponseError: ResponseErrorHandler | null;

    /** The number of transient retries after the first try. */
    readonly #retryAttempts: number;

    /** The backoff strategy spacing retry attempts. */
    readonly #retryBackoff: ExponentialBackoff;

    /**
     * Construct a new HTTP client.
     *
     * @param options - base URL, optional fetch override, timeout, default
     * headers, interceptors, and retry policy
     */
    constructor(options: FetchHttpClientOptions) {
        this.#baseUrl = options.baseUrl.replace(/\/+$/u, '');
        this.#fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
        this.#timeout = options.timeout ?? null;
        this.#defaultHeaders = options.defaultHeaders ?? {};
        this.#interceptors = options.requestInterceptors ?? [];
        this.#onUnauthorized = options.onUnauthorized ?? null;
        this.#onResponseError = options.onResponseError ?? null;
        this.#retryAttempts = options.retry?.attempts ?? (options.retry === undefined ? 0 : 2);
        this.#retryBackoff = options.retry?.backoff ?? new ExponentialBackoff();
    }

    /**
     * Send a GET request; transient failures are retried per the configured
     * retry policy.
     */
    get<T>(path: string, options?: HttpRequestOptions): Promise<T> {
        return this.#sendAttempt(
            {
                method: 'GET',
                path,
                body: undefined,
                options,
                shouldRetryUnauthorized: true,
                idempotent: true,
                parse: 'json',
            },
            0,
        );
    }

    /**
     * Send a POST request; transient failures are not retried.
     */
    post<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
        return this.#sendAttempt(
            { method: 'POST', path, body, options, shouldRetryUnauthorized: true, idempotent: false, parse: 'json' },
            0,
        );
    }

    /**
     * Send a PUT request; transient failures are not retried.
     */
    put<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
        return this.#sendAttempt(
            { method: 'PUT', path, body, options, shouldRetryUnauthorized: true, idempotent: false, parse: 'json' },
            0,
        );
    }

    /**
     * Send a PATCH request; transient failures are not retried.
     */
    patch<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
        return this.#sendAttempt(
            { method: 'PATCH', path, body, options, shouldRetryUnauthorized: true, idempotent: false, parse: 'json' },
            0,
        );
    }

    /**
     * Send a DELETE request; transient failures are not retried.
     */
    delete<T>(path: string, options?: HttpRequestOptions): Promise<T> {
        return this.#sendAttempt(
            {
                method: 'DELETE',
                path,
                body: undefined,
                options,
                shouldRetryUnauthorized: true,
                idempotent: false,
                parse: 'json',
            },
            0,
        );
    }

    /**
     * Download a GET response as a raw Blob; transient failures are retried per
     * the retry policy.
     */
    download(path: string, options?: HttpRequestOptions): Promise<Blob> {
        return this.#sendAttempt<Blob>(
            {
                method: 'GET',
                path,
                body: undefined,
                options,
                shouldRetryUnauthorized: true,
                idempotent: true,
                parse: 'blob',
            },
            0,
        );
    }

    /**
     * Run one attempt of a request, retrying transient failures on idempotent
     * requests (with a backoff delay) until the retry budget is exhausted, then
     * notify the response-error handler with the final outcome only.
     *
     * @param sendRequest - the request descriptor
     * @param attempt - zero-based attempt counter for this call
     * @returns the parsed response body once an attempt succeeds
     */
    async #sendAttempt<T>(sendRequest: SendRequest, attempt: number): Promise<T> {
        const context: AttemptContext = { request: null };

        try {
            return await this.#dispatchOnce<T>(sendRequest, context);
        } catch (error) {
            if (sendRequest.idempotent && attempt < this.#retryAttempts && isTransientError(error)) {
                await this.#awaitBackoff(attempt);

                return this.#sendAttempt<T>(sendRequest, attempt + 1);
            }

            if (context.request !== null && !(error instanceof CancelledError)) {
                this.#notifyResponseError(error, context.request, sendRequest.options);
            }

            throw error;
        }
    }

    /**
     * Await the retry-backoff delay for a given attempt index.
     *
     * @param attempt - zero-based attempt counter
     */
    async #awaitBackoff(attempt: number): Promise<void> {
        const delay = this.#retryBackoff.delayFor(attempt);

        await new Promise<void>(resolve => {
            setTimeout(resolve, delay);
        });
    }

    /**
     * Resolve the request through interceptors, dispatch it, and run the
     * 401-refresh-and-retry-once flow. Never notifies the response-error
     * handler - {@link FetchHttpClient.#sendAttempt} does that once, for the
     * final outcome only.
     *
     * @param sendRequest - the request descriptor
     * @param context - records the resolved request for the caller's error
     * notification
     * @returns the parsed response body on success
     */
    async #dispatchOnce<T>(sendRequest: SendRequest, context: AttemptContext): Promise<T> {
        const { method, path, body, options, parse } = sendRequest;

        const request = await this.#applyInterceptors({
            method,
            url: this.#buildUrl(path, options?.query),
            headers: { ...this.#defaultHeaders, ...options?.headers },
            body,
        });

        context.request = request;

        const response = await this.#dispatch(request, options?.signal);
        const retried = await this.#refreshAndRetryOnUnauthorized<T>(response, sendRequest, context);

        if (retried.recovered) {
            return retried.value;
        }

        if (!response.ok) {
            throw await toResponseError(response);
        }

        return await parseResponseBody<T>(response, parse);
    }

    /**
     * Run the 401-refresh-and-retry-once flow when the response and request are
     * eligible.
     *
     * @param response - the response to check for a 401 status
     * @param sendRequest - the request descriptor that produced the response
     * @param context - forwarded to the retried attempt, for error notification
     * @returns a recovered result when a refresh succeeded and the retry ran,
     * else not-recovered
     */
    async #refreshAndRetryOnUnauthorized<T>(
        response: Response,
        sendRequest: SendRequest,
        context: AttemptContext,
    ): Promise<UnauthorizedRetryResult<T>> {
        const { options, shouldRetryUnauthorized } = sendRequest;
        const eligible = response.status === 401 && shouldRetryUnauthorized && options?.retryOnUnauthorized !== false;

        if (!eligible || this.#onUnauthorized === null || !(await this.#onUnauthorized())) {
            return { recovered: false };
        }

        const value = await this.#dispatchOnce<T>({ ...sendRequest, shouldRetryUnauthorized: false }, context);

        return { recovered: true, value };
    }

    /**
     * Report a request failure to the configured response-error handler.
     *
     * @param error - the {@link HttpError} or {@link NetworkError} about to be
     * thrown
     * @param request - the fully-resolved request that failed
     * @param options - the per-request options, checked for a notifyOnError
     * opt-out
     */
    #notifyResponseError(error: unknown, request: HttpRequest, options: HttpRequestOptions | undefined): void {
        if (this.#onResponseError === null || options?.notifyOnError === false) {
            return;
        }

        try {
            this.#onResponseError(error, request);
        } catch {
            // A misbehaving handler must never mask the original error.
        }
    }

    /**
     * Thread the request through every registered interceptor, in registration
     * order, so each sees the previous interceptor's output.
     *
     * @param initial - the request before any interceptor runs
     * @returns the request after the final interceptor
     */
    async #applyInterceptors(initial: HttpRequest): Promise<HttpRequest> {
        let request = initial;

        for (const interceptor of this.#interceptors) {
            request = await interceptor(request);
        }

        return request;
    }

    /**
     * Perform the fetch, mapping a deliberate abort onto {@link CancelledError}
     * and any other transport failure onto {@link NetworkError}.
     *
     * @param request - the fully-resolved request to send
     * @param callerSignal - the per-request abort signal, if any
     * @returns the raw fetch response
     */
    async #dispatch(request: HttpRequest, callerSignal: AbortSignal | undefined): Promise<Response> {
        const signal = this.#resolveSignal(callerSignal);

        try {
            return await this.#fetchFn(request.url, this.#buildRequestInit(request, signal));
        } catch (error) {
            if (isAbortError(error) || signal?.aborted === true) {
                throw new CancelledError(`${request.method} ${request.url} was cancelled.`, { cause: error });
            }

            throw new NetworkError(`${request.method} ${request.url} failed without a response.`, { cause: error });
        }
    }

    /**
     * Build the fetch `RequestInit`, passing FormData and Blob bodies through
     * unchanged and JSON-serialising any other body with a default
     * content-type.
     *
     * @param request - the resolved request to translate
     * @param signal - the effective abort signal, or null when none applies
     * @returns the RequestInit to hand to fetch
     */
    #buildRequestInit(request: HttpRequest, signal: AbortSignal | null): RequestInit {
        const headers = { ...request.headers };

        const init: RequestInit = {
            method: request.method,
            headers,
            signal,
        };

        if (isUploadBody(request.body)) {
            // The browser sets the multipart boundary or Blob content-type
            // itself; overriding it here would strip that information.
            init.body = request.body;
        } else if (request.body !== undefined) {
            if (!hasHeader(headers, 'content-type')) {
                headers['content-type'] = 'application/json';
            }

            init.body = JSON.stringify(request.body);
        }

        return init;
    }

    /**
     * Resolve the effective abort signal for a request, composing a
     * caller-supplied signal with the configured timeout so that a caller
     * signal no longer silently disables the timeout.
     *
     * @param callerSignal - the per-request signal, if any
     * @returns the signal to pass to fetch, or null when neither is configured
     */
    #resolveSignal(callerSignal: AbortSignal | undefined): AbortSignal | null {
        const timeoutSignal = this.#buildTimeoutSignal();

        if (callerSignal === undefined) {
            return timeoutSignal;
        }

        return timeoutSignal === null ? callerSignal : AbortSignal.any([callerSignal, timeoutSignal]);
    }

    /**
     * Build the per-request timeout signal from the configured timeout.
     *
     * @returns a signal that aborts once the timeout elapses, or null when no
     * timeout is configured
     */
    #buildTimeoutSignal(): AbortSignal | null {
        return this.#timeout === null ? null : AbortSignal.timeout(this.#timeout);
    }

    /**
     * Join the base URL with a request path and append encoded query
     * parameters, dropping undefined values.
     *
     * @param path - the request path, whose leading slashes are trimmed
     * @param query - the query parameters to encode, if any
     * @returns the absolute request URL, with a query string when present
     */
    #buildUrl(path: string, query: QueryParameters | undefined): string {
        const url = `${this.#baseUrl}/${path.replace(/^\/+/u, '')}`;
        const parameters = new URLSearchParams();

        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined) {
                parameters.set(key, String(value));
            }
        }

        const encoded = parameters.toString();

        return encoded === '' ? url : `${url}?${encoded}`;
    }
}

/**
 * Determine whether a header is present, case-insensitively.
 *
 * @param headers - the header record to inspect
 * @param name - the lower-case header name to look for
 * @returns true when the header is present
 */
function hasHeader(headers: Record<string, string>, name: string): boolean {
    return Object.keys(headers).some(key => key.toLowerCase() === name);
}

/**
 * Determine whether a request body should be handed to fetch unchanged.
 *
 * @param body - the request body
 * @returns true when the body is a FormData or Blob instance
 */
function isUploadBody(body: unknown): body is FormData | Blob {
    return body instanceof FormData || body instanceof Blob;
}

/**
 * Determine whether a fetch rejection represents a deliberate abort rather than
 * a genuine transport failure.
 *
 * @param error - the value fetch rejected with
 * @returns true when the error is a DOMException named AbortError
 */
function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Determine whether a failed attempt is eligible for a transient retry.
 *
 * @param error - the error thrown by the failed attempt
 * @returns true for a {@link NetworkError} or an {@link HttpError} with a 502,
 * 503, or 504 status; a {@link CancelledError} is never transient
 */
function isTransientError(error: unknown): boolean {
    if (error instanceof NetworkError) {
        return true;
    }

    return error instanceof HttpError && TRANSIENT_STATUSES.has(error.status);
}

/**
 * Parse a successful response body.
 *
 * @param response - the fetch response
 * @param parse - 'blob' reads the raw response body; 'json' parses JSON, falls
 * back to raw text, or undefined for an empty body
 * @returns the parsed payload, matching the requested parse mode
 */
async function parseResponseBody<T>(response: Response, parse: BodyParseMode): Promise<T> {
    if (parse === 'blob') {
        // Cast justified: 'blob' mode is only selected by
        // FetchHttpClient#download, whose public signature guarantees T is
        // Blob.
        return (await response.blob()) as T;
    }

    const text = await response.text();

    if (text === '') {
        // Caller-declared response typing is the port's contract; an empty body
        // maps to undefined which callers type as void or undefined explicitly.
        return undefined as T;
    }

    if (isJsonResponse(response)) {
        // Caller-declared response typing is the port's contract; validation
        // happens at module gateway boundaries, not inside the transport.
        return JSON.parse(text) as T;
    }

    // Caller-declared response typing is the port's contract; the caller types
    // plain-text responses as string when using a non-JSON endpoint.
    return text as T;
}

/**
 * Map a non-success response onto the error hierarchy.
 *
 * @param response - the fetch response
 * @returns the mapped error, ready to throw
 */
async function toResponseError(response: Response): Promise<HttpError> {
    const payload = await parsePayload(response);
    const message = resolveErrorMessage(payload, response.status);
    const errors = resolveValidationErrors(payload);

    if (response.status === 422 && errors !== null) {
        return new HttpValidationError(response.status, message, payload, errors);
    }

    return new HttpError(response.status, message, payload);
}

/**
 * Best-effort parse of an error response body.
 *
 * @param response - the fetch response
 * @returns the parsed JSON payload, or null when the body is not JSON
 */
async function parsePayload(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

/**
 * Resolve a human-readable message from an error payload.
 *
 * @param payload - the parsed error payload
 * @param status - the response status code
 * @returns the payload's message when present, else a generic status message
 */
function resolveErrorMessage(payload: unknown, status: number): string {
    if (isRecord(payload) && typeof payload['message'] === 'string') {
        return payload['message'];
    }

    return `Request failed with status ${status}.`;
}

/**
 * Extract a per-field validation error map from an error payload.
 *
 * @param payload - the parsed error payload
 * @returns the normalised error map, or null when the payload carries none
 */
function resolveValidationErrors(payload: unknown): Record<string, readonly string[]> | null {
    if (!isRecord(payload) || !isRecord(payload['errors'])) {
        return null;
    }

    const errors: Record<string, readonly string[]> = {};

    for (const [field, messages] of Object.entries(payload['errors'])) {
        if (Array.isArray(messages)) {
            errors[field] = messages.filter((message): message is string => typeof message === 'string');
        }
    }

    return errors;
}

/**
 * Determine whether a response declares a JSON body.
 *
 * @param response - the fetch response
 * @returns true when the content type is JSON
 */
function isJsonResponse(response: Response): boolean {
    return (response.headers.get('content-type') ?? '').includes('json');
}
