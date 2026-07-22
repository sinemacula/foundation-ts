/**
 * Bearer-token request interceptor.
 *
 * Attaches `Authorization: Bearer <token>` to outgoing requests. The token
 * comes from an {@link AccessTokenProvider} port so the HTTP layer stays
 * decoupled from any particular auth store.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { HttpRequest, RequestInterceptor } from './http-client';

/**
 * Supplies the current access token, if any.
 */
export interface AccessTokenProvider {
    /**
     * Resolve the current access token.
     *
     * @returns the token, or null when unauthenticated
     */
    getAccessToken(): string | null;
}

/**
 * Build an interceptor that attaches the provider's token to each request.
 *
 * Requests that already carry an Authorization header are left untouched.
 *
 * @param provider - the access token provider
 * @returns the request interceptor
 */
export function createBearerTokenInterceptor(provider: AccessTokenProvider): RequestInterceptor {
    return (request: HttpRequest): HttpRequest => {
        const token = provider.getAccessToken();

        if (token === null || hasAuthorizationHeader(request)) {
            return request;
        }

        return {
            ...request,
            headers: { ...request.headers, authorization: `Bearer ${token}` },
        };
    };
}

/**
 * Determine whether a request already carries an Authorization header.
 *
 * @param request - the outgoing request
 * @returns true when an Authorization header is present
 */
function hasAuthorizationHeader(request: HttpRequest): boolean {
    return Object.keys(request.headers).some(key => key.toLowerCase() === 'authorization');
}
