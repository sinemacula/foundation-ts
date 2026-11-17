/**
 * HTTP contributions collected from module registration.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { RequestInterceptor, ResponseErrorHandler, UnauthorizedHandler } from './http-client';

/**
 * The HTTP machinery collected from every module's register phase.
 */
export interface ModuleHttpContributions {
    /** Request interceptors gathered in registry order. */
    readonly requestInterceptors: readonly RequestInterceptor[];

    /** The single unauthorized handler, or null when none was set. */
    readonly onUnauthorized: UnauthorizedHandler | null;

    /** Response-error handlers gathered in registry order. */
    readonly responseErrorHandlers: readonly ResponseErrorHandler[];
}
