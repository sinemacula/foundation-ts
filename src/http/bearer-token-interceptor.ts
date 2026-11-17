/**
 * Request interceptor attaching a bearer token from an access-token port.
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
 * Build an interceptor that sends the provider's token as a bearer
 * Authorization header, leaving a request untouched when there is no token or
 * it already carries one.
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
 * Determine whether a request already carries an Authorization header,
 * case-insensitively.
 */
function hasAuthorizationHeader(request: HttpRequest): boolean {
    return Object.keys(request.headers).some(key => key.toLowerCase() === 'authorization');
}
