/**
 * Default session API gateway.
 *
 * Implements {@link SessionApi} over the documented controllers of the
 * organisation's authentication package: `POST auth/sign-in` signs in,
 * `POST auth/refresh` refreshes, `POST auth/logout` signs out, and the user
 * record lives at `users/self`. A session response is
 * `{ access_token, expires_in, refresh_token }` (expiry in seconds), or
 * `{ pending_credential, requires }` when a further step such as a second
 * factor is owed; a `{ data }` envelope around either is tolerated. An API
 * whose protocol differs beyond the paths implements {@link SessionApi}
 * instead.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { HttpClient, HttpRequestOptions } from '../http/http-client';
import { isRecord } from '../support/is-record';
import type { PasswordCredentials, SessionApi, SessionDevice } from './session-api';
import { SessionError } from './session-error';
import type { LoginResult, RefreshResult } from './session-outcomes';
import { classifyRefreshError } from './session-outcomes';
import type { SessionTokens } from './session-tokens';
import type { SessionUser } from './session-user';

/**
 * How the refresh token travels.
 *
 * - `body`: the client holds the refresh token and sends it in the request
 *   body; the default, and the one for React Native
 * - `cookie`: for browsers; the server keeps the token in an HttpOnly cookie
 *   the client never sees, so the sign-in, refresh and sign-out requests send
 *   credentials and the `X-Requested-With` header the server's cross-site check
 *   requires
 */
export type RefreshTokenTransport = 'body' | 'cookie';

/**
 * The session endpoint paths, relative to the HTTP client's base URL.
 */
export interface SessionPaths {
    /** Default 'auth/sign-in'. */
    readonly login?: string;

    /** Default 'auth/refresh'. */
    readonly refresh?: string;

    /** Default 'auth/logout'. */
    readonly logout?: string;

    /** The user resource, fetched with GET. Default 'users/self'. */
    readonly user?: string;
}

/**
 * Options for {@link createDefaultSessionApi}.
 */
export interface DefaultSessionApiOptions<C = PasswordCredentials> {
    /** How the refresh token travels. Default 'body'. */
    readonly transport?: RefreshTokenTransport;

    /** Overrides for the endpoint paths. */
    readonly paths?: SessionPaths;

    /** Build the sign-in request body. Defaults to the credentials plus `platform` set to the device's operating system. */
    readonly loginBody?: (credentials: C, device: SessionDevice) => unknown;

    /** The clock the access token expiry is computed against, in epoch milliseconds. Default `Date.now`. */
    readonly now?: () => number;
}

/**
 * The user mapping a gateway over a richer user type than {@link SessionUser}
 * requires.
 */
export interface SessionUserMapping<U extends SessionUser> {
    /** Map the user payload, with any `{ data }` envelope removed, onto U. */
    readonly mapUser: (payload: unknown) => U;
}

const DEFAULT_PATHS: Required<SessionPaths> = {
    login: 'auth/sign-in',
    refresh: 'auth/refresh',
    logout: 'auth/logout',
    user: 'users/self',
};

const REFRESH_TOKEN_FIELD = 'refresh_token';
const CROSS_SITE_HEADERS: Readonly<Record<string, string>> = { 'X-Requested-With': 'XMLHttpRequest' };

/**
 * Create a {@link SessionApi} over the application HTTP client, mapping the
 * user record onto {@link SessionUser}: id, email, first plus last name, and
 * the string permissions.
 *
 * No sign-in, refresh or sign-out request may trigger the unauthorized handler,
 * so a refused sign-in cannot refresh and resurrect an earlier session. Refresh
 * and sign-out failures are not reported to the global error handler, since
 * they surface through the session flow. A refresh never throws: every failure
 * is classified into its result, and in body transport a refresh without a
 * refresh token is rejected without a request.
 *
 * @param http - the HTTP client used to reach the session endpoints
 * @param options - the transport and wire overrides
 * @returns the session API gateway
 */
export function createDefaultSessionApi<C = PasswordCredentials>(
    http: HttpClient,
    options?: DefaultSessionApiOptions<C>,
): SessionApi<SessionUser, C>;

/**
 * Create a {@link SessionApi} over the application HTTP client, mapping the
 * user record onto U with the given mapping.
 *
 * @param http - the HTTP client used to reach the session endpoints
 * @param options - the user mapping, with the transport and wire overrides
 * @returns the session API gateway
 */
export function createDefaultSessionApi<C, U extends SessionUser>(
    http: HttpClient,
    options: DefaultSessionApiOptions<C> & SessionUserMapping<U>,
): SessionApi<U, C>;

export function createDefaultSessionApi<C, U extends SessionUser>(
    http: HttpClient,
    options: DefaultSessionApiOptions<C> & Partial<SessionUserMapping<U>> = {},
): SessionApi<U | SessionUser, C> {
    const transport = options.transport ?? 'body';
    const paths: Required<SessionPaths> = { ...DEFAULT_PATHS, ...options.paths };
    const loginBody = options.loginBody ?? defaultLoginBody;
    const mapUser = options.mapUser ?? mapDefaultUser;
    const mapSession = createSessionMapper(transport, options.now ?? Date.now);
    const cookie: HttpRequestOptions =
        transport === 'cookie' ? { headers: CROSS_SITE_HEADERS, credentials: 'include' } : {};
    const signIn: HttpRequestOptions = { ...cookie, retryOnUnauthorized: false };
    const quiet: HttpRequestOptions = { ...signIn, notifyOnError: false };

    /**
     * Build the body carrying the refresh token, or none when the token does
     * not travel in the body.
     *
     * @param refreshToken - the held refresh token, or null
     * @returns the request body, or undefined
     */
    const tokenBody = (refreshToken: string | null): Record<string, unknown> | undefined =>
        transport === 'body' && refreshToken !== null ? { [REFRESH_TOKEN_FIELD]: refreshToken } : undefined;

    return {
        async login(credentials, device): Promise<LoginResult> {
            const raw = await http.post<unknown>(paths.login, loginBody(credentials, device), signIn);

            return mapSession(raw);
        },
        async refresh(refreshToken): Promise<RefreshResult> {
            if (transport === 'body' && refreshToken === null) {
                return { kind: 'rejected', error: new SessionError('No refresh token is held to refresh with.') };
            }

            try {
                const raw = await http.post<unknown>(paths.refresh, tokenBody(refreshToken), quiet);
                const result = mapSession(raw);

                return result.kind === 'authenticated' ? { kind: 'refreshed', tokens: result.tokens } : result;
            } catch (error) {
                return { kind: classifyRefreshError(error), error };
            }
        },
        async logout(refreshToken): Promise<void> {
            await http.post<unknown>(paths.logout, tokenBody(refreshToken), quiet);
        },
        async currentUser(): Promise<U | SessionUser> {
            const raw = await http.get<unknown>(paths.user);

            return mapUser(unwrapOptionalEnvelope(raw));
        },
    };
}

/**
 * Build the default sign-in body: the credentials plus the device platform.
 *
 * @param credentials - the submitted credentials
 * @param device - the device fingerprint
 * @returns the request body
 */
function defaultLoginBody<C>(credentials: C, device: SessionDevice): unknown {
    return { ...credentials, platform: device.os };
}

/**
 * Create the session response mapper.
 *
 * @param transport - how the refresh token travels; a cookie transport ignores
 * any refresh token in the body
 * @param now - the clock the expiry is computed against
 * @returns the mapper
 */
function createSessionMapper(transport: RefreshTokenTransport, now: () => number): (payload: unknown) => LoginResult {
    return (payload: unknown): LoginResult => {
        const data = unwrapOptionalEnvelope(payload);

        if (!isRecord(data)) {
            throw malformedSession();
        }

        const pendingCredential = data['pending_credential'];

        if (typeof pendingCredential === 'string') {
            return {
                kind: 'interactionRequired',
                pending: { credential: pendingCredential, requires: strings(data['requires']) },
            };
        }

        return { kind: 'authenticated', tokens: readTokens(data, transport, now) };
    };
}

/**
 * Read and validate the tokens of a session response. A missing refresh token
 * or expiry reads as null.
 *
 * @param data - the unwrapped response record
 * @param transport - how the refresh token travels; a cookie transport ignores
 * any refresh token in the body
 * @param now - the clock the expiry is computed against
 * @returns the tokens
 * @throws {@link SessionError} when a field has the wrong shape
 */
function readTokens(data: Record<string, unknown>, transport: RefreshTokenTransport, now: () => number): SessionTokens {
    const accessToken = data['access_token'];
    const expiresIn = data['expires_in'] ?? null;
    const refreshToken = transport === 'cookie' ? null : (data[REFRESH_TOKEN_FIELD] ?? null);

    if (typeof accessToken !== 'string' || accessToken === '') {
        throw malformedSession();
    }

    if (expiresIn !== null && !(typeof expiresIn === 'number' && expiresIn > 0)) {
        throw malformedSession();
    }

    if (refreshToken !== null && typeof refreshToken !== 'string') {
        throw malformedSession();
    }

    return { accessToken, refreshToken, expiresAtEpochMs: expiresIn === null ? null : now() + expiresIn * 1000 };
}

/**
 * Build the error thrown for a session response that does not match the
 * expected shape.
 *
 * @returns the error
 */
function malformedSession(): SessionError {
    return new SessionError('The session response did not match the expected shape.');
}

/**
 * Unwrap a `{ data: {...} }` envelope when present.
 *
 * @param payload - the raw response payload
 * @returns the enveloped record, or the payload itself when not enveloped
 */
function unwrapOptionalEnvelope(payload: unknown): unknown {
    return isRecord(payload) && isRecord(payload['data']) ? payload['data'] : payload;
}

/**
 * Map an unwrapped user payload onto the base {@link SessionUser} shape.
 *
 * The identifier is required; email and name degrade to null when absent so the
 * default mapping tolerates sparse user records. The display name joins the
 * wire `first_name` and `last_name` fields.
 *
 * @param payload - the unwrapped user payload
 * @returns the mapped user
 * @throws {@link SessionError} when the payload is not a record with a usable
 * identifier
 */
function mapDefaultUser(payload: unknown): SessionUser {
    if (!isRecord(payload)) {
        throw new SessionError('The user response did not match the expected shape.');
    }

    const id = payload['id'];

    if (typeof id !== 'string' && typeof id !== 'number') {
        throw new SessionError('The user response did not match the expected shape.');
    }

    return {
        id,
        email: typeof payload['email'] === 'string' ? payload['email'] : null,
        name: composeName(payload['first_name'], payload['last_name']),
        permissions: strings(payload['permissions']),
    };
}

/**
 * Join the wire name fields into a display name.
 *
 * @param first - the raw `first_name` field
 * @param last - the raw `last_name` field
 * @returns the space-joined string parts, or null when neither is a string
 */
function composeName(first: unknown, last: unknown): string | null {
    const parts = [first, last].filter((part): part is string => typeof part === 'string');

    return parts.length === 0 ? null : parts.join(' ');
}

/**
 * Extract the string entries of a list field.
 *
 * @param value - the raw field value
 * @returns the string entries of `value` when it is an array, otherwise an
 * empty array
 */
function strings(value: unknown): readonly string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.filter((entry): entry is string => typeof entry === 'string');
}
