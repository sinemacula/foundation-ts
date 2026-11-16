/**
 * Fetch-backed adapter for the {@link HttpClient} port.
 *
 * JSON-first: requests ask for JSON, request bodies are serialised to JSON,
 * JSON responses are parsed, and non-success responses are mapped onto the
 * {@link HttpError} hierarchy from the API error envelope, falling back to the
 * plain `{message, errors}` shape. FormData and Blob bodies are passed to fetch
 * unchanged for uploads, and {@link FetchHttpClient.download} reads a response
 * as a raw Blob. A single optional unauthorized handler supports
 * refresh-and-retry token flows without coupling this adapter to any auth
 * implementation, and an optional response-error handler is notified of every
 * ultimate failure so an application can surface it globally. A caller abort
 * rejects with {@link CancelledError} and a configured timeout with
 * {@link TimeoutError}, so a deliberate cancel is never confused with a
 * transport failure, and every failure to read or parse a body stays inside the
 * typed hierarchy. An opt-in `retry` policy re-attempts transient failures on
 * idempotent requests with a backoff delay between attempts.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { ExponentialBackoff } from '../realtime/exponential-backoff';
import { stripQueryAndFragment } from '../support/url';
import { onAbort, openAbortScope } from './abort-scope';
import type { AbortScope } from './abort-scope';
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
import {
    CancelledError,
    HttpError,
    MaintenanceError,
    NetworkError,
    ResponseParseError,
    TimeoutError,
} from './http-error';
import { toResponseError } from './response-error';

/**
 * A delay strategy spacing retry attempts, such as an
 * {@link ExponentialBackoff}.
 */
export interface RetryBackoff {
    /**
     * Compute the delay before the retry that follows a failed attempt.
     *
     * @param attempt - zero-based index of the failed attempt
     * @returns the delay in milliseconds
     */
    delayFor(attempt: number): number;
}

/**
 * Opt-in transient-retry policy for idempotent requests:
 * {@link FetchHttpClient.get} and {@link FetchHttpClient.download}. POST, PUT,
 * PATCH, and DELETE never retry regardless of this policy. A
 * {@link NetworkError} (including a {@link TimeoutError}) or a 502, 503 or 504
 * response is retried; a {@link CancelledError} or {@link MaintenanceError}
 * never is.
 */
export interface FetchHttpClientRetryOptions {
    /** Number of retries attempted after the first try. Defaults to 2. */
    readonly attempts?: number;

    /** Delay strategy between attempts. Defaults to a new {@link ExponentialBackoff}, shared with the realtime reconnect scheduling. */
    readonly backoff?: RetryBackoff;
}

/** Construction options for {@link FetchHttpClient}. */
export interface FetchHttpClientOptions {
    /** Base URL that every request path is resolved against. */
    readonly baseUrl: string;

    /** Fetch implementation to use; defaults to the global fetch. */
    readonly fetchFn?: typeof fetch;

    /** Per-request timeout in milliseconds, covering the response body; omit, or pass zero or less, for none. */
    readonly timeout?: number;

    /** Headers sent on every request unless overridden. An `accept` header here or per request replaces the JSON default. */
    readonly defaultHeaders?: Readonly<Record<string, string>>;

    /** Interceptors applied to each request in registration order. */
    readonly requestInterceptors?: readonly RequestInterceptor[];

    /** Handler invoked on a 401 to attempt a refresh-and-retry. */
    readonly onUnauthorized?: UnauthorizedHandler;

    /** Invoked whenever a request ultimately fails. This is where an application wires a toast or error-reporting call; per-request `notifyOnError: false` opts a request out. The handler receives every ultimate failure except {@link CancelledError} (a deliberate cancel is never reported), including {@link HttpValidationError} and {@link TimeoutError}, so filtering expected failures is left to the handler. */
    readonly onResponseError?: ResponseErrorHandler;

    /** Opt-in retry policy for transient failures. Omit entirely for a single attempt on every request; see {@link FetchHttpClientRetryOptions}. */
    readonly retry?: FetchHttpClientRetryOptions;
}

/** How a successful response body is read: parsed JSON/text, or a raw Blob. */
type BodyParseMode = 'json' | 'blob';

/** HTTP statuses treated as transient, and therefore retryable, failures. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** The default `accept` header per parse mode; downloads still prefer JSON errors. */
const DEFAULT_ACCEPT: Readonly<Record<BodyParseMode, string>> = {
    json: 'application/json',
    blob: 'application/json, */*;q=0.8',
};

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
    readonly #retryBackoff: RetryBackoff;

    /**
     * Construct a new HTTP client.
     *
     * @param options - base URL, optional fetch override, timeout, default
     * headers, interceptors, and retry policy
     */
    constructor(options: FetchHttpClientOptions) {
        this.#baseUrl = trimTrailingSlashes(options.baseUrl);
        this.#fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
        const timeout = options.timeout ?? 0;

        this.#timeout = timeout > 0 ? timeout : null;
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
                await this.#awaitBackoff(attempt, sendRequest, context.request);

                return this.#sendAttempt<T>(sendRequest, attempt + 1);
            }

            if (context.request !== null && !(error instanceof CancelledError)) {
                this.#notifyResponseError(error, context.request, sendRequest.options);
            }

            throw error;
        }
    }

    /**
     * Await the retry-backoff delay for a given attempt index, cutting it short
     * with a {@link CancelledError} when the caller's signal aborts.
     *
     * @param attempt - zero-based attempt counter
     * @param sendRequest - the request descriptor, carrying the caller signal
     * @param request - the failed attempt's resolved request, or null when an
     * interceptor failed before one existed
     */
    async #awaitBackoff(attempt: number, sendRequest: SendRequest, request: HttpRequest | null): Promise<void> {
        const { method, path, options } = sendRequest;
        const delay = this.#retryBackoff.delayFor(attempt);
        const target = describeRequest(request ?? { method, url: this.#buildUrl(path, options?.query) });

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                detach();
                resolve();
            }, delay);

            const detach = onAbort(options?.signal, reason => {
                clearTimeout(timer);
                reject(new CancelledError(`${target} was cancelled before its retry.`, { cause: reason }));
            });
        });
    }

    /**
     * Resolve the request through interceptors, exchange it, and run the
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
            headers: withDefaultAccept({ ...this.#defaultHeaders, ...options?.headers }, parse),
            body,
        });

        context.request = request;

        try {
            return await this.#exchange<T>(request, sendRequest);
        } catch (error) {
            if (!(await this.#refreshedAfter(error, sendRequest))) {
                throw error;
            }
        }

        return this.#dispatchOnce<T>({ ...sendRequest, shouldRetryUnauthorized: false }, context);
    }

    /**
     * Send the request and read its body under one abort scope, so the
     * configured timeout covers the body as well as the headers.
     *
     * @param request - the fully-resolved request to send
     * @param sendRequest - the request descriptor, carrying the caller signal
     * and parse mode
     * @returns the parsed response body on success
     */
    async #exchange<T>(request: HttpRequest, sendRequest: SendRequest): Promise<T> {
        const scope = openAbortScope(this.#timeout, sendRequest.options?.signal);

        try {
            const response = await this.#dispatch(request, scope);

            if (!response.ok) {
                const text = await this.#readBody(response, request, scope, read => read.text());

                throw toResponseError(response.status, text);
            }

            return await this.#parseResponseBody<T>(response, request, scope, sendRequest.parse);
        } finally {
            scope.dispose();
        }
    }

    /**
     * Run the unauthorized handler when a failure is an eligible 401. A
     * rejecting handler counts as a failed refresh, so the original 401 stands.
     *
     * @param error - the failure of the exchange
     * @param sendRequest - the request descriptor that produced it
     * @returns true when a refresh succeeded and the request should be retried
     */
    async #refreshedAfter(error: unknown, sendRequest: SendRequest): Promise<boolean> {
        const { options, shouldRetryUnauthorized } = sendRequest;
        const eligible =
            error instanceof HttpError &&
            error.status === 401 &&
            shouldRetryUnauthorized &&
            options?.retryOnUnauthorized !== false;

        if (!eligible || this.#onUnauthorized === null) {
            return false;
        }

        try {
            return await this.#onUnauthorized();
        } catch {
            return false;
        }
    }

    /**
     * Report a request failure to the configured response-error handler.
     *
     * @param error - the error about to be thrown
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
     * Perform the fetch, mapping a rejection onto the typed transport errors.
     *
     * @param request - the fully-resolved request to send
     * @param scope - the abort scope governing the exchange
     * @returns the raw fetch response
     */
    async #dispatch(request: HttpRequest, scope: AbortScope): Promise<Response> {
        try {
            return await this.#fetchFn(request.url, buildRequestInit(request, scope.signal));
        } catch (error) {
            throw this.#toTransportError(error, request, scope, 'failed without a response');
        }
    }

    /**
     * Read a response body, mapping a read failure (a dropped connection, a
     * timeout, or a caller abort mid-body) onto the typed transport errors.
     *
     * @param response - the fetch response
     * @param request - the request that produced it
     * @param scope - the abort scope governing the exchange
     * @param read - reads the body in the wanted form
     * @returns the body as read
     */
    async #readBody<R>(
        response: Response,
        request: HttpRequest,
        scope: AbortScope,
        read: (response: Response) => Promise<R>,
    ): Promise<R> {
        try {
            return await read(response);
        } catch (error) {
            throw this.#toTransportError(error, request, scope, 'failed while reading the response body');
        }
    }

    /**
     * Parse a successful response body.
     *
     * @param response - the fetch response
     * @param request - the request that produced it
     * @param scope - the abort scope governing the exchange
     * @param parse - 'blob' reads the raw response body; 'json' parses JSON,
     * falls back to raw text, or undefined for an empty body
     * @returns the parsed payload, matching the requested parse mode
     */
    async #parseResponseBody<T>(
        response: Response,
        request: HttpRequest,
        scope: AbortScope,
        parse: BodyParseMode,
    ): Promise<T> {
        if (parse === 'blob') {
            // Cast justified: 'blob' mode is only selected by
            // FetchHttpClient#download, whose public signature guarantees T is
            // Blob.
            return (await this.#readBody(response, request, scope, read => read.blob())) as T;
        }

        const text = await this.#readBody(response, request, scope, read => read.text());

        if (text === '') {
            // Caller-declared response typing is the port's contract; an empty
            // body maps to undefined which callers type as void or undefined
            // explicitly.
            return undefined as T;
        }

        if (!isJsonResponse(response)) {
            // Caller-declared response typing is the port's contract; the
            // caller types plain-text responses as string when using a non-JSON
            // endpoint.
            return text as T;
        }

        try {
            // Caller-declared response typing is the port's contract;
            // validation happens at module gateway boundaries, not inside the
            // transport.
            return JSON.parse(text) as T;
        } catch (error) {
            throw new ResponseParseError(
                response.status,
                `${describeRequest(request)} returned a JSON body that could not be parsed.`,
                { cause: error },
            );
        }
    }

    /**
     * Classify a fetch or body-read rejection by what aborted the exchange: the
     * timeout is a {@link TimeoutError}, the caller a {@link CancelledError},
     * and nothing a {@link NetworkError}, even when the rejection is an
     * `AbortError`, since only a recorded source proves a deliberate abort.
     *
     * @param error - the rejection
     * @param request - the request being exchanged
     * @param scope - the abort scope governing the exchange
     * @param failure - how the request failed, for the network-error message
     * @returns the typed error to throw
     */
    #toTransportError(error: unknown, request: HttpRequest, scope: AbortScope, failure: string): Error {
        const target = describeRequest(request);

        switch (scope.source()) {
            case 'timeout':
                return new TimeoutError(`${target} timed out after ${String(this.#timeout)}ms.`, { cause: error });
            case 'caller':
                return new CancelledError(`${target} was cancelled.`, { cause: error });
            case 'none':
                return new NetworkError(`${target} ${failure}.`, { cause: error });
        }
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
                // append, not set: keys are unique by construction, and some
                // minimal URLSearchParams implementations ship append only.
                parameters.append(key, String(value));
            }
        }

        const encoded = parameters.toString();

        return encoded === '' ? url : `${url}?${encoded}`;
    }
}

/**
 * Build the fetch `RequestInit`, passing FormData and Blob bodies through
 * unchanged and JSON-serialising any other body with a default content-type.
 *
 * @param request - the resolved request to translate
 * @param signal - the effective abort signal, or null when none applies
 * @returns the RequestInit to hand to fetch
 */
function buildRequestInit(request: HttpRequest, signal: AbortSignal | null): RequestInit {
    const headers = { ...request.headers };

    const init: RequestInit = {
        method: request.method,
        headers,
        signal,
    };

    if (isUploadBody(request.body)) {
        // The fetch implementation sets the multipart boundary or Blob
        // content-type itself; overriding it here would strip that information.
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
 * Add the default `accept` header unless one is already present, so the API
 * renders errors as JSON rather than an HTML page or a redirect.
 *
 * @param headers - the merged default and per-request headers
 * @param parse - the parse mode, selecting the default
 * @returns the headers with an `accept` header
 */
function withDefaultAccept(headers: Record<string, string>, parse: BodyParseMode): Record<string, string> {
    return hasHeader(headers, 'accept') ? headers : { accept: DEFAULT_ACCEPT[parse], ...headers };
}

/**
 * Describe a request for an error message, without its query string or
 * fragment.
 *
 * @param request - the request to describe
 * @returns the method and stripped URL
 */
function describeRequest(request: Pick<HttpRequest, 'method' | 'url'>): string {
    return `${request.method} ${stripQueryAndFragment(request.url)}`;
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
 * Trim trailing slashes with a linear scan.
 *
 * A `+`-then-anchor regex backtracks polynomially on slash runs, so the trim
 * walks the string instead.
 *
 * @param value - the string to trim
 * @returns the value without trailing slashes
 */
function trimTrailingSlashes(value: string): string {
    let end = value.length;

    while (end > 0 && value[end - 1] === '/') {
        end -= 1;
    }

    return value.slice(0, end);
}

/**
 * Determine whether a failed attempt is eligible for a transient retry.
 *
 * @param error - the error thrown by the failed attempt
 * @returns true for a {@link NetworkError} (including a {@link TimeoutError})
 * or an {@link HttpError} with a 502, 503, or 504 status that is not a
 * {@link MaintenanceError}
 */
function isTransientError(error: unknown): boolean {
    if (error instanceof NetworkError) {
        return true;
    }

    return error instanceof HttpError && !(error instanceof MaintenanceError) && TRANSIENT_STATUSES.has(error.status);
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
