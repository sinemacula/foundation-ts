/**
 * Fetch-backed adapter for the {@link HttpClient} port.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { ExponentialBackoff } from '../realtime/exponential-backoff';
import { clampTimerDelay, MAX_TIMER_DELAY } from '../support/timer';
import { stripQueryAndFragment } from '../support/url';
import { onAbort, openAbortScope, untilAborted } from './abort-scope';
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
     * @returns the delay in milliseconds; one above 2147483647 waits that long
     */
    delayFor(attempt: number): number;
}

/**
 * Opt-in transient-retry policy, applied only to {@link FetchHttpClient.get}
 * and {@link FetchHttpClient.download}. A {@link NetworkError} (including a
 * {@link TimeoutError}) or a 502, 503 or 504 response is retried; a
 * {@link CancelledError} never is, and nor is a {@link MaintenanceError}, since
 * a maintenance window outlasts any backoff.
 */
export interface FetchHttpClientRetryOptions {
    /** Number of retries attempted after the first try. Defaults to 2. */
    readonly attempts?: number;

    /** Delay strategy between attempts. Defaults to a new {@link ExponentialBackoff}. */
    readonly backoff?: RetryBackoff;
}

/** Construction options for {@link FetchHttpClient}. */
export interface FetchHttpClientOptions {
    /** Base URL that every request path is resolved against. */
    readonly baseUrl: string;

    /** Fetch implementation to use; defaults to the global fetch. */
    readonly fetchFn?: typeof fetch;

    /** Per-request timeout in milliseconds, covering the response body, at most 2147483647; omit, or pass zero or less, for none. */
    readonly timeout?: number;

    /** Headers sent on every request unless overridden, names compared case-insensitively. An `accept` header here or per request replaces the JSON default. */
    readonly defaultHeaders?: Readonly<Record<string, string>>;

    /** Interceptors applied to each request in registration order. */
    readonly requestInterceptors?: readonly RequestInterceptor[];

    /** Handler invoked on a 401 to attempt a refresh-and-retry. */
    readonly onUnauthorized?: UnauthorizedHandler;

    /** Told of each final request failure; see {@link ResponseErrorHandler}. */
    readonly onResponseError?: ResponseErrorHandler;

    /** Opt-in retry policy for transient failures; omit for a single attempt on every request. */
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
 * A request as described by the public method, before interceptors resolve it.
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
 * Mutable record of one attempt: its most recently resolved request, read for
 * final-outcome error notification, and whether it spent the call's single
 * unauthorized-handler invocation.
 */
interface AttemptContext {
    /** The most recently resolved request, or null before dispatch. */
    request: HttpRequest | null;

    /** Whether the unauthorized handler has been invoked. */
    unauthorizedHandled: boolean;
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
     * @throws {RangeError} when the timeout exceeds the timer maximum or is NaN
     */
    constructor(options: FetchHttpClientOptions) {
        const timeout = options.timeout ?? 0;

        if (!(timeout <= MAX_TIMER_DELAY)) {
            throw new RangeError(
                `The request timeout must be at most ${String(MAX_TIMER_DELAY)} ms; pass zero or less for none.`,
            );
        }

        this.#baseUrl = trimTrailingSlashes(options.baseUrl);
        this.#fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
        this.#timeout = timeout > 0 ? timeout : null;
        this.#defaultHeaders = options.defaultHeaders ?? {};
        this.#interceptors = options.requestInterceptors ?? [];
        this.#onUnauthorized = options.onUnauthorized ?? null;
        this.#onResponseError = options.onResponseError ?? null;
        this.#retryAttempts = options.retry?.attempts ?? (options.retry === undefined ? 0 : 2);
        this.#retryBackoff = options.retry?.backoff ?? new ExponentialBackoff();
    }

    /**
     * Send a GET request.
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
     * Send a POST request.
     */
    post<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
        return this.#sendAttempt(
            { method: 'POST', path, body, options, shouldRetryUnauthorized: true, idempotent: false, parse: 'json' },
            0,
        );
    }

    /**
     * Send a PUT request.
     */
    put<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
        return this.#sendAttempt(
            { method: 'PUT', path, body, options, shouldRetryUnauthorized: true, idempotent: false, parse: 'json' },
            0,
        );
    }

    /**
     * Send a PATCH request.
     */
    patch<T>(path: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
        return this.#sendAttempt(
            { method: 'PATCH', path, body, options, shouldRetryUnauthorized: true, idempotent: false, parse: 'json' },
            0,
        );
    }

    /**
     * Send a DELETE request.
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
     * Download a GET response as a raw Blob.
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
     * Run a request, retrying transient failures on idempotent requests until
     * the retry budget runs out, and report only the final failure. The
     * unauthorized handler runs at most once across all attempts.
     *
     * @param attempt - zero-based attempt counter for this call
     */
    async #sendAttempt<T>(sendRequest: SendRequest, attempt: number): Promise<T> {
        const context: AttemptContext = { request: null, unauthorizedHandled: false };

        try {
            return await this.#dispatchOnce<T>(sendRequest, context);
        } catch (error) {
            if (sendRequest.idempotent && attempt < this.#retryAttempts && isTransientError(error)) {
                await this.#awaitBackoff(attempt, sendRequest, context.request);

                const shouldRetryUnauthorized = sendRequest.shouldRetryUnauthorized && !context.unauthorizedHandled;

                return this.#sendAttempt<T>({ ...sendRequest, shouldRetryUnauthorized }, attempt + 1);
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
     * @param request - the failed attempt's resolved request, or null when an
     * interceptor failed before one existed
     */
    async #awaitBackoff(attempt: number, sendRequest: SendRequest, request: HttpRequest | null): Promise<void> {
        const { method, path, options } = sendRequest;
        const delay = clampTimerDelay(this.#retryBackoff.delayFor(attempt));
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
     * Resolve the request through the interceptors and exchange it, retrying
     * once after a successful 401 refresh. Never notifies the response-error
     * handler; the caller does that for the final outcome.
     *
     * @param context - records the resolved request for the caller's error
     * notification, and the handler invocation
     */
    async #dispatchOnce<T>(sendRequest: SendRequest, context: AttemptContext): Promise<T> {
        const { method, path, body, options, parse } = sendRequest;

        const request = await this.#applyInterceptors(
            {
                method,
                url: this.#buildUrl(path, options?.query),
                headers: mergeHeaders({ accept: DEFAULT_ACCEPT[parse] }, this.#defaultHeaders, options?.headers),
                body,
                ...(options?.credentials === undefined ? {} : { credentials: options.credentials }),
            },
            options?.signal,
        );

        context.request = request;

        try {
            return await this.#exchange<T>(request, sendRequest);
        } catch (error) {
            if (!(await this.#refreshedAfter(error, sendRequest, request, context))) {
                throw error;
            }
        }

        return this.#dispatchOnce<T>({ ...sendRequest, shouldRetryUnauthorized: false }, context);
    }

    /**
     * Send the request and read its body under one abort scope, so the
     * configured timeout covers the body as well as the headers.
     */
    async #exchange<T>(request: HttpRequest, sendRequest: SendRequest): Promise<T> {
        throwIfCancelled(request, sendRequest.options?.signal);

        const scope = openAbortScope(this.#timeout, sendRequest.options?.signal);

        try {
            const response = await this.#dispatch(request, scope);

            if (!response.ok) {
                const text = await this.#readBody(response, request, scope, read => read.text());

                throw toResponseError(response.status, text);
            }

            return (await this.#parseResponseBody(response, request, scope, sendRequest.parse)) as T;
        } finally {
            scope.dispose();
        }
    }

    /**
     * Run the unauthorized handler with the request that received an eligible
     * 401. A rejecting handler counts as a failed refresh, so the original 401
     * stands; a caller abort stops the wait but never the handler, whose work
     * may be shared with other requests.
     *
     * @param request - the resolved request that received the failure
     * @param context - marks the handler as invoked for this call
     * @returns true when a refresh succeeded and the request should be retried
     */
    async #refreshedAfter(
        error: unknown,
        sendRequest: SendRequest,
        request: HttpRequest,
        context: AttemptContext,
    ): Promise<boolean> {
        const { options, shouldRetryUnauthorized } = sendRequest;
        const handler = this.#onUnauthorized;
        const eligible =
            error instanceof HttpError &&
            error.status === 401 &&
            shouldRetryUnauthorized &&
            options?.retryOnUnauthorized !== false;

        if (!eligible || handler === null) {
            return false;
        }

        const signal = options?.signal;

        throwIfCancelled(request, signal);
        context.unauthorizedHandled = true;

        return await untilAborted(canRetry(handler, request), signal, reason => cancelledError(request, reason));
    }

    /**
     * Report a failure to the response-error handler unless the request opted
     * out.
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
     * Thread the request through every interceptor in registration order,
     * canonicalising the header names each one returns. A caller abort stops
     * the chain at once, and no later interceptor runs.
     */
    async #applyInterceptors(initial: HttpRequest, signal: AbortSignal | undefined): Promise<HttpRequest> {
        let request = initial;

        for (const interceptor of this.#interceptors) {
            const input = request;

            throwIfCancelled(input, signal);

            const output = await untilAborted(Promise.resolve(interceptor(input)), signal, reason =>
                cancelledError(input, reason),
            );

            request = { ...output, headers: mergeHeaders(output.headers) };
        }

        return request;
    }

    /**
     * Perform the fetch, mapping a rejection onto the typed transport errors.
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
     * Parse a successful response body: a Blob in blob mode, otherwise the
     * parsed JSON, the raw text of a non-JSON response, or undefined when
     * empty.
     */
    async #parseResponseBody(
        response: Response,
        request: HttpRequest,
        scope: AbortScope,
        parse: BodyParseMode,
    ): Promise<unknown> {
        if (parse === 'blob') {
            return await this.#readBody(response, request, scope, read => read.blob());
        }

        const text = await this.#readBody(response, request, scope, read => read.text());

        if (text === '') {
            return undefined;
        }

        if (!isJsonResponse(response)) {
            return text;
        }

        try {
            return JSON.parse(text);
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
     * @param failure - how the request failed, for the network-error message
     */
    #toTransportError(error: unknown, request: HttpRequest, scope: AbortScope, failure: string): Error {
        const target = describeRequest(request);

        switch (scope.source()) {
            case 'timeout':
                return new TimeoutError(`${target} timed out after ${String(this.#timeout)}ms.`, { cause: error });
            case 'caller':
                return cancelledError(request, error);
            case 'none':
                return new NetworkError(`${target} ${failure}.`, { cause: error });
        }
    }

    /**
     * Join the base URL with a request path and merge in the encoded query
     * parameters, dropping undefined values. A query already in the path is
     * kept and extended, and a fragment stays last.
     *
     * @param path - the request path, whose leading slashes are trimmed
     */
    #buildUrl(path: string, query: QueryParameters | undefined): string {
        const hashAt = path.indexOf('#');
        const resource = (hashAt === -1 ? path : path.slice(0, hashAt)).replace(/^\/+/u, '');
        const fragment = hashAt === -1 ? '' : path.slice(hashAt);
        const parameters = new URLSearchParams();

        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined) {
                // Minimal URLSearchParams implementations may ship append only.
                parameters.append(toWellFormed(key), toWellFormed(String(value)));
            }
        }

        const encoded = parameters.toString();
        const search = encoded === '' ? '' : `${querySeparator(resource)}${encoded}`;

        return `${this.#baseUrl}/${resource}${search}${fragment}`;
    }
}

/**
 * Build the fetch `RequestInit`, passing FormData and Blob bodies through
 * unchanged and JSON-serialising any other body with a default content-type. A
 * FormData body drops any content-type, since only fetch knows its multipart
 * boundary.
 *
 * @param signal - the effective abort signal, or null when none applies
 */
function buildRequestInit(request: HttpRequest, signal: AbortSignal | null): RequestInit {
    const headers = { ...request.headers };

    const init: RequestInit = {
        method: request.method,
        headers,
        signal,
    };

    if (request.credentials !== undefined) {
        init.credentials = request.credentials;
    }

    if (request.body instanceof FormData) {
        delete headers['content-type'];
        init.body = request.body;
    } else if (request.body instanceof Blob) {
        init.body = request.body;
    } else if (request.body !== undefined) {
        headers['content-type'] ??= 'application/json';
        init.body = JSON.stringify(request.body);
    }

    return init;
}

/**
 * Merge header records into one keyed by lower-case name, a later source
 * replacing an earlier one whatever the case of either.
 */
function mergeHeaders(...sources: ReadonlyArray<Readonly<Record<string, string>> | undefined>): Record<string, string> {
    const merged = new Map<string, string>();

    for (const source of sources) {
        for (const [name, value] of Object.entries(source ?? {})) {
            merged.set(name.toLowerCase(), value);
        }
    }

    // Own properties, so a `__proto__` header never reaches the prototype.
    return Object.fromEntries(merged);
}

/**
 * Choose the separator that appends a query to a path that may already carry
 * one.
 */
function querySeparator(resource: string): string {
    if (!resource.includes('?')) {
        return '?';
    }

    return resource.endsWith('?') || resource.endsWith('&') ? '' : '&';
}

/**
 * Replace lone surrogates with U+FFFD, as Node's encoder does, since a strict
 * encoder throws on them instead.
 */
function toWellFormed(value: string): string {
    return value.replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
}

/**
 * Ask the unauthorized handler whether to retry, counting a rejection or a
 * synchronous throw as a refusal.
 */
async function canRetry(handler: UnauthorizedHandler, request: HttpRequest): Promise<boolean> {
    try {
        return await handler(request);
    } catch {
        return false;
    }
}

/**
 * Throw a {@link CancelledError} when the caller's signal has already aborted.
 */
function throwIfCancelled(request: Pick<HttpRequest, 'method' | 'url'>, signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw cancelledError(request, signal.reason);
    }
}

/**
 * Build the {@link CancelledError} for a request the caller aborted.
 *
 * @param cause - the abort reason, or the transport rejection it caused
 */
function cancelledError(request: Pick<HttpRequest, 'method' | 'url'>, cause: unknown): CancelledError {
    return new CancelledError(`${describeRequest(request)} was cancelled.`, { cause });
}

/**
 * Describe a request for an error message, without its query string or
 * fragment.
 */
function describeRequest(request: Pick<HttpRequest, 'method' | 'url'>): string {
    return `${request.method} ${stripQueryAndFragment(request.url)}`;
}

/**
 * Trim trailing slashes by scanning; a `/+$` regex backtracks polynomially.
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
 */
function isTransientError(error: unknown): boolean {
    if (error instanceof NetworkError) {
        return true;
    }

    return error instanceof HttpError && !(error instanceof MaintenanceError) && TRANSIENT_STATUSES.has(error.status);
}

/**
 * Determine whether a response declares a JSON content type.
 */
function isJsonResponse(response: Response): boolean {
    return (response.headers.get('content-type') ?? '').includes('json');
}
