/**
 * Default session API gateway.
 *
 * Implements {@link SessionApi} over the documented controllers of the
 * organisation's authentication package: `POST auth/sign-in` signs in,
 * `POST auth/refresh` refreshes, `POST auth/logout` signs out, and the user
 * record lives at `users/self`. A session response is
 * `{ access_token, expires_in, refresh_token }` (expiry in seconds), or
 * `{ pending_credential, requires }` when a further step such as a second
 * factor is owed; a `{ data }` envelope around either is tolerated. The refresh
 * token travels in the request body, or in an HttpOnly cookie the client never
 * sees. Paths, methods, field names and parsing are all injectable through
 * {@link DefaultSessionApiOptions} so an application whose controllers differ
 * adapts the mapping instead of replacing the gateway.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { HttpClient, HttpRequestOptions } from '../http/http-client';
import { isRecord } from '../support/is-record';
import type { PasswordCredentials, SessionApi, SessionDevice } from './session-api';
import { SessionError } from './session-error';
import type { LoginResult, RefreshFailureKind, RefreshResult } from './session-outcomes';
import { classifyRefreshError } from './session-outcomes';
import type { SessionTokens } from './session-tokens';
import type { SessionUser } from './session-user';

/**
 * How the refresh token travels.
 *
 * - `body`: the client holds the refresh token and sends it in the request body
 * - `cookie`: the server keeps it in an HttpOnly cookie; the client never sees
 *   it, sends no token, and adds the cross-site request header instead. The
 *   HTTP client must send credentials (cookies) on the session requests, which
 *   a same-origin API gets by default.
 */
export type RefreshTokenTransport = 'body' | 'cookie';

/** The HTTP methods a session endpoint can be reached with. */
export type SessionRequestMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A session endpoint's path and method. A `DELETE` sends no body.
 */
export interface SessionEndpoint {
    /** The path, relative to the HTTP client's base URL. */
    readonly path: string;

    /** The HTTP method. */
    readonly method: SessionRequestMethod;
}

/**
 * The wire field names of a session response, also used for the refresh token
 * the client sends.
 */
export interface SessionResponseFields {
    /** Default 'access_token'. */
    readonly accessToken: string;

    /** The access token lifetime in seconds. Default 'expires_in'. */
    readonly expiresIn: string;

    /** Default 'refresh_token'. */
    readonly refreshToken: string;

    /** Default 'pending_credential'. */
    readonly pendingCredential: string;

    /** The list of outstanding requirements of a pending session. Default 'requires'. */
    readonly requires: string;
}

/**
 * A request header and its value.
 */
export interface SessionHeader {
    /** The header name. */
    readonly name: string;

    /** The header value; must be non-empty. */
    readonly value: string;
}

/**
 * Injection points for {@link createDefaultSessionApi}; the authentication
 * package's documented controllers ship as the defaults.
 */
export interface DefaultSessionApiOptions<U extends SessionUser = SessionUser, C = PasswordCredentials> {
    /** How the refresh token travels. Default 'body'. */
    readonly transport?: RefreshTokenTransport;

    /** Endpoint overrides. Defaults: login `POST auth/sign-in`, refresh `POST auth/refresh`, logout `POST auth/logout`, user `users/self`. */
    readonly endpoints?: {
        /** The sign-in endpoint. */
        readonly login?: SessionEndpoint;

        /** The refresh endpoint. */
        readonly refresh?: SessionEndpoint;

        /** The sign-out endpoint. */
        readonly logout?: SessionEndpoint;

        /** The user resource path, fetched with GET. */
        readonly user?: string;
    };

    /** Overrides for the session response field names. */
    readonly fields?: Partial<SessionResponseFields>;

    /** The header a cookie-transport request carries so the server can refuse cross-site requests; null sends none. Default `X-Requested-With: XMLHttpRequest`. */
    readonly crossSiteHeader?: SessionHeader | null;

    /** Build the sign-in request body. Defaults to the credentials plus `platform` set to the device's operating system. */
    readonly loginBody?: (credentials: C, device: SessionDevice) => unknown;

    /** Map a sign-in or refresh response body. Defaults to the documented shapes, tolerating a `{ data }` envelope, and throwing a {@link SessionError} for a malformed body. */
    readonly mapSession?: (payload: unknown) => LoginResult;

    /** Classify a failed refresh. Defaults to {@link classifyRefreshError}. */
    readonly classifyRefreshError?: (error: unknown) => RefreshFailureKind;

    /** Unwrap the user response. Defaults to unwrapping a `{ data }` envelope when present. */
    readonly unwrap?: (payload: unknown) => unknown;

    /** Map the unwrapped user payload onto U. This is the adaptation point for APIs that shape the user record differently. Defaults to mapping id, email, first plus last name, and permissions, with a non-array permissions field collapsing to an empty list. */
    readonly mapUser?: (payload: unknown) => U;

    /** The clock the access token expiry is computed against, in epoch milliseconds. Default `Date.now`. */
    readonly now?: () => number;
}

const DEFAULT_FIELDS: SessionResponseFields = {
    accessToken: 'access_token',
    expiresIn: 'expires_in',
    refreshToken: 'refresh_token',
    pendingCredential: 'pending_credential',
    requires: 'requires',
};

const DEFAULT_CROSS_SITE_HEADER: SessionHeader = { name: 'X-Requested-With', value: 'XMLHttpRequest' };

/**
 * Create a {@link SessionApi} over the application HTTP client.
 *
 * The refresh and sign-out requests are sent with `retryOnUnauthorized: false`
 * so a 401 cannot recurse back into the unauthorized handler, and with
 * `notifyOnError: false` because their failures surface through the session
 * flow, not a generic error toast. A refresh never throws: every failure is
 * classified into its result. In body transport a refresh without a refresh
 * token is rejected without a request, as the server would reject it.
 *
 * @param http - the HTTP client used to reach the session endpoints
 * @param options - overrides for the documented wire conventions
 * @returns the session API gateway
 */
export function createDefaultSessionApi<U extends SessionUser = SessionUser, C = PasswordCredentials>(
    http: HttpClient,
    options: DefaultSessionApiOptions<U, C> = {},
): SessionApi<U, C> {
    const transport = options.transport ?? 'body';
    const fields: SessionResponseFields = { ...DEFAULT_FIELDS, ...options.fields };
    const crossSiteHeader = options.crossSiteHeader === undefined ? DEFAULT_CROSS_SITE_HEADER : options.crossSiteHeader;
    const loginEndpoint = options.endpoints?.login ?? { path: 'auth/sign-in', method: 'POST' };
    const refreshEndpoint = options.endpoints?.refresh ?? { path: 'auth/refresh', method: 'POST' };
    const logoutEndpoint = options.endpoints?.logout ?? { path: 'auth/logout', method: 'POST' };
    const userEndpoint = options.endpoints?.user ?? 'users/self';
    const loginBody = options.loginBody ?? defaultLoginBody;
    const classify = options.classifyRefreshError ?? classifyRefreshError;
    const unwrap = options.unwrap ?? unwrapOptionalEnvelope;
    const mapUser = options.mapUser ?? (mapDefaultUser as (payload: unknown) => U);
    const mapSession = options.mapSession ?? createSessionMapper(fields, transport, options.now ?? Date.now);

    const cookieHeaders: Readonly<Record<string, string>> =
        transport === 'cookie' && crossSiteHeader !== null ? { [crossSiteHeader.name]: crossSiteHeader.value } : {};
    const quiet: HttpRequestOptions = { notifyOnError: false, retryOnUnauthorized: false, headers: cookieHeaders };

    /**
     * Build the body carrying the refresh token, or none when the token does
     * not travel in the body.
     *
     * @param refreshToken - the held refresh token, or null
     * @returns the request body, or undefined
     */
    const tokenBody = (refreshToken: string | null): Record<string, unknown> | undefined =>
        transport === 'body' && refreshToken !== null ? wire([[fields.refreshToken, refreshToken]]) : undefined;

    return {
        async login(credentials, device): Promise<LoginResult> {
            const raw = await send(http, loginEndpoint, loginBody(credentials, device), { headers: cookieHeaders });

            return mapSession(raw);
        },
        async refresh(refreshToken): Promise<RefreshResult> {
            if (transport === 'body' && refreshToken === null) {
                return { kind: 'rejected', error: new SessionError('No refresh token is held to refresh with.') };
            }

            try {
                const result = mapSession(await send(http, refreshEndpoint, tokenBody(refreshToken), quiet));

                return result.kind === 'authenticated' ? { kind: 'refreshed', tokens: result.tokens } : result;
            } catch (error) {
                return { kind: classify(error), error };
            }
        },
        async logout(refreshToken): Promise<void> {
            await send(http, logoutEndpoint, tokenBody(refreshToken), quiet);
        },
        async currentUser(): Promise<U> {
            const raw = await http.get<unknown>(userEndpoint);

            return mapUser(unwrap(raw));
        },
    };
}

/**
 * Send a request to a session endpoint with its configured method.
 *
 * @param http - the HTTP client
 * @param endpoint - the endpoint to reach
 * @param body - the request body; dropped for DELETE
 * @param options - the request options
 * @returns the response payload
 */
function send(
    http: HttpClient,
    endpoint: SessionEndpoint,
    body: unknown,
    options: HttpRequestOptions,
): Promise<unknown> {
    switch (endpoint.method) {
        case 'POST':
            return http.post<unknown>(endpoint.path, body, options);
        case 'PUT':
            return http.put<unknown>(endpoint.path, body, options);
        case 'PATCH':
            return http.patch<unknown>(endpoint.path, body, options);
        case 'DELETE':
            return http.delete<unknown>(endpoint.path, options);
    }
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
 * Create the default session response mapper.
 *
 * @param fields - the wire field names
 * @param transport - how the refresh token travels; a cookie transport ignores
 * any refresh token in the body
 * @param now - the clock the expiry is computed against
 * @returns the mapper
 */
function createSessionMapper(
    fields: SessionResponseFields,
    transport: RefreshTokenTransport,
    now: () => number,
): (payload: unknown) => LoginResult {
    return (payload: unknown): LoginResult => {
        const data = unwrapOptionalEnvelope(payload);

        if (!isRecord(data)) {
            throw malformedSession();
        }

        const pendingCredential = data[fields.pendingCredential];

        if (typeof pendingCredential === 'string') {
            return {
                kind: 'interactionRequired',
                pending: { credential: pendingCredential, requires: strings(data[fields.requires]) },
            };
        }

        return { kind: 'authenticated', tokens: readTokens(data, fields, transport, now) };
    };
}

/**
 * Read and validate the tokens of a session response. A missing refresh token
 * or expiry reads as null.
 *
 * @param data - the unwrapped response record
 * @param fields - the wire field names
 * @param transport - how the refresh token travels; a cookie transport ignores
 * any refresh token in the body
 * @param now - the clock the expiry is computed against
 * @returns the tokens
 * @throws {@link SessionError} when a field has the wrong shape
 */
function readTokens(
    data: Record<string, unknown>,
    fields: SessionResponseFields,
    transport: RefreshTokenTransport,
    now: () => number,
): SessionTokens {
    const accessToken = data[fields.accessToken];
    const expiresIn = data[fields.expiresIn] ?? null;
    const refreshToken = transport === 'cookie' ? null : (data[fields.refreshToken] ?? null);

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
 * Build a `Record<string, unknown>` from an array of `[key, value]` pairs.
 *
 * Keeps snake_case wire-field names out of object-literal key positions so
 * naming-convention lint rules never see them.
 *
 * @param entries - key-value pairs for the record
 * @returns a plain `Record<string, unknown>`
 */
function wire(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
    return Object.fromEntries(entries);
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
