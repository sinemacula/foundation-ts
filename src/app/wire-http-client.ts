/**
 * HTTP client wiring for the bootstrap preset.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { FetchHttpClient } from '../http/fetch-http-client';
import type {
    HttpClient,
    HttpRequest,
    RequestInterceptor,
    ResponseErrorHandler,
    UnauthorizedHandler,
} from '../http/http-client';
import { HttpError, HttpValidationError } from '../http/http-error';
import type { ModuleHttpContributions } from '../http/module-http-contributions';
import { stripQueryAndFragment } from '../support/url';
import { installApi, reporting, toasts } from './services';
import type { FoundationConfig } from './foundation-config';

/**
 * The resolved construction inputs handed to a client-factory override.
 */
export interface WireHttpClientTools<T extends FoundationConfig> {
    /** The frozen application configuration. */
    readonly config: Readonly<T>;

    /** The resolved fetch seam. */
    readonly fetchFn: typeof fetch;

    /** Preset interceptors followed by module contributions, in order. */
    readonly interceptors: readonly RequestInterceptor[];

    /** The single module-contributed refresh authority, when one exists. */
    readonly onUnauthorized: UnauthorizedHandler | null;

    /** The fully-resolved response-error handler, module handlers included. */
    readonly onResponseError: ResponseErrorHandler;
}

/**
 * Inputs for {@link wireHttpClient}.
 */
export interface WireHttpClientOptions<T extends FoundationConfig> {
    /** The frozen application configuration. */
    readonly config: Readonly<T>;

    /** The resolved fetch seam. */
    readonly fetchFn: typeof fetch;

    /** Preset-level interceptors, run before every module contribution. */
    readonly interceptors?: readonly RequestInterceptor[];

    /** The register phase's collected module HTTP contributions. */
    readonly contributions: ModuleHttpContributions;

    /** Full replacement of the preset response-error handler. */
    readonly onResponseError?: ResponseErrorHandler;

    /** Arms the default handler's toast; the kernel ships no translations. */
    readonly unexpectedErrorToastKey?: string;

    /** Full adapter override; receives the resolved construction inputs. */
    readonly client?: (tools: WireHttpClientTools<T>) => HttpClient;
}

/**
 * Build and install the application HTTP client.
 *
 * `onResponseError` replaces the default handler, which ignores validation
 * failures and 401s and otherwise toasts (when a key is set) and reports the
 * error. Module handlers run after it in registry order; each step is isolated,
 * so a throw is reported and never skips the rest. Reported URLs drop their
 * query string and fragment.
 */
export function wireHttpClient<T extends FoundationConfig>(options: WireHttpClientOptions<T>): HttpClient {
    const tools: WireHttpClientTools<T> = {
        config: options.config,
        fetchFn: options.fetchFn,
        interceptors: [...(options.interceptors ?? []), ...options.contributions.requestInterceptors],
        onUnauthorized: options.contributions.onUnauthorized,
        onResponseError: composeResponseErrorHandler(options),
    };

    const client = options.client?.(tools) ?? buildDefaultClient(tools);

    installApi(client);

    return client;
}

/**
 * Construct the default fetch-backed client from the resolved inputs.
 */
function buildDefaultClient<T extends FoundationConfig>(tools: WireHttpClientTools<T>): HttpClient {
    return new FetchHttpClient({
        baseUrl: tools.config.api.baseUrl,
        timeout: tools.config.api.timeout,
        fetchFn: tools.fetchFn,
        requestInterceptors: tools.interceptors,
        onResponseError: tools.onResponseError,
        ...(tools.onUnauthorized === null ? {} : { onUnauthorized: tools.onUnauthorized }),
    });
}

/**
 * Compose the resolved preset handler with the module contributions, which
 * always run after it in registry order.
 */
function composeResponseErrorHandler<T extends FoundationConfig>(
    options: WireHttpClientOptions<T>,
): ResponseErrorHandler {
    const preset = options.onResponseError ?? createDefaultResponseErrorHandler(options.unexpectedErrorToastKey);
    const moduleHandlers = options.contributions.responseErrorHandlers;

    return (error, request) => {
        for (const handler of [preset, ...moduleHandlers]) {
            runIsolated(request, () => {
                handler(error, request);
            });
        }
    };
}

/**
 * Build the default handler for unexpected request failures. Validation
 * failures are left to the form and 401s to the refresh flow; the toast and
 * reporting services are resolved on every call.
 *
 * @param toastKey - the application's toast key, or undefined to capture only
 */
function createDefaultResponseErrorHandler(toastKey: string | undefined): ResponseErrorHandler {
    return (error, request) => {
        if (error instanceof HttpValidationError || (error instanceof HttpError && error.status === 401)) {
            return;
        }

        if (toastKey !== undefined) {
            runIsolated(request, () => {
                toasts().error(toastKey);
            });
        }

        reporting().captureError(error, reportContext('http', request));
    };
}

/**
 * Run one response-error step, capturing a failure instead of letting it skip
 * the remaining steps. A failure to capture is dropped, since the reporter is
 * the only place left to send it.
 */
function runIsolated(request: HttpRequest, step: () => void): void {
    try {
        step();
    } catch (failure) {
        try {
            reporting().captureError(failure, reportContext('http-response-error-handler', request));
        } catch {
            // The reporter is unavailable or failing; nothing is left to tell.
        }
    }
}

/**
 * Build the context a failure is reported with, its URL stripped of the query
 * string and fragment.
 *
 * @param source - what reported the failure
 */
function reportContext(source: string, request: HttpRequest): Readonly<Record<string, string>> {
    return { source, method: request.method, url: stripQueryAndFragment(request.url) };
}
