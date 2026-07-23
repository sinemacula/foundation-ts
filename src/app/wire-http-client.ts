/**
 * HTTP client wiring unit for the bootstrap preset.
 *
 * Builds the application HTTP client from the frozen configuration, the
 * resolved fetch seam, preset-level interceptors, and the module registry's
 * register-phase contributions, then installs it into the base http holder. The
 * response-error handler resolves in precedence order: an explicit override
 * wins; otherwise a configured toast key arms the default handler, which skips
 * validation failures and 401s, raises the application's toast, and captures
 * the error with request context; otherwise unexpected failures are captured
 * only. Module response-error handlers always run after the resolved handler,
 * in registry order, and the toast and reporting services are read lazily on
 * every invocation.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { FetchHttpClient } from '../http/fetch-http-client';
import type { HttpClient, RequestInterceptor, ResponseErrorHandler, UnauthorizedHandler } from '../http/http-client';
import { HttpError, HttpValidationError } from '../http/http-error';
import type { ModuleHttpContributions } from '../http/module-http-contributions';
import { installApi, reporting, toasts } from './services';
import type { FoundationConfig } from './foundation-config';

/**
 * The resolved construction inputs handed to a client-factory override.
 */
export interface WireHttpClientTools<C extends FoundationConfig> {
    /** The frozen application configuration. */
    readonly config: Readonly<C>;

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
export interface WireHttpClientOptions<C extends FoundationConfig> {
    /** The frozen application configuration. */
    readonly config: Readonly<C>;

    /** The resolved fetch seam. */
    readonly fetchFn: typeof fetch;

    /** Preset-level interceptors, run before every module contribution. */
    readonly interceptors?: readonly RequestInterceptor[];

    /** The register phase's collected module HTTP contributions. */
    readonly contributions: ModuleHttpContributions;

    /** Full replacement of the preset response-error handler. */
    readonly onResponseError?: ResponseErrorHandler;

    /** Arms the default handler's toast; the kernel ships no translation keys. */
    readonly unexpectedErrorToastKey?: string;

    /** Full adapter override; receives the resolved construction inputs. */
    readonly client?: (tools: WireHttpClientTools<C>) => HttpClient;
}

/**
 * Build and install the application HTTP client.
 *
 * @param options - configuration, seams, module contributions, and overrides
 * @returns the installed HTTP client
 */
export function wireHttpClient<C extends FoundationConfig>(options: WireHttpClientOptions<C>): HttpClient {
    const tools: WireHttpClientTools<C> = {
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
 *
 * @param tools - the resolved construction inputs
 * @returns the configured client
 */
function buildDefaultClient<C extends FoundationConfig>(tools: WireHttpClientTools<C>): HttpClient {
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
 *
 * @param options - the wiring inputs carrying the override, key, and handlers
 * @returns the composed response-error handler
 */
function composeResponseErrorHandler<C extends FoundationConfig>(options: WireHttpClientOptions<C>): ResponseErrorHandler {
    const preset = options.onResponseError ?? createDefaultResponseErrorHandler(options.unexpectedErrorToastKey);
    const moduleHandlers = options.contributions.responseErrorHandlers;

    return (error, request) => {
        preset(error, request);

        for (const handler of moduleHandlers) {
            handler(error, request);
        }
    };
}

/**
 * Build the default handler for unexpected request failures.
 *
 * Validation failures stay silent (forms render their field errors) and 401s
 * belong to the refresh flow; everything else raises the application's toast
 * when a key is configured and is captured with request context. The toast and
 * reporting services are resolved lazily on every invocation.
 *
 * @param toastKey - the application's toast key, or undefined to capture only
 * @returns the default response-error handler
 */
function createDefaultResponseErrorHandler(toastKey: string | undefined): ResponseErrorHandler {
    return (error, request) => {
        if (error instanceof HttpValidationError || (error instanceof HttpError && error.status === 401)) {
            return;
        }

        if (toastKey !== undefined) {
            toasts().error(toastKey);
        }

        reporting().captureError(error, { source: 'http', method: request.method, url: request.url });
    };
}
