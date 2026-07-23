/**
 * Default session API gateway.
 *
 * Implements {@link SessionApi} over the organisation's wire conventions: the
 * session resource lives at `auth` (POST to log in, PATCH to refresh, DELETE to
 * log out), the user record at `users/self`, responses arrive in a `{ data }`
 * envelope, and session expiry is a naive `YYYY-MM-DD HH:MM:SS` timestamp
 * interpreted as UTC. Every convention is injectable through
 * {@link DefaultSessionApiOptions} so diverging APIs adjust the mapping here
 * instead of replacing the gateway.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { HttpClient } from '../http/http-client';
import { isRecord } from '../support/is-record';
import type { SessionApi } from './session-api';
import { SessionError } from './session-error';
import type { SessionTokens } from './session-tokens';
import type { SessionUser } from './session-user';

const DEFAULT_SESSION_ENDPOINT = 'auth';
const DEFAULT_USER_ENDPOINT = 'users/self';

/**
 * Injection points for {@link createDefaultSessionApi}; the organisation's wire
 * conventions ship as the defaults.
 */
export interface DefaultSessionApiOptions<U extends SessionUser = SessionUser> {
    /** Resource paths. Defaults: session `auth`, user `users/self`. */
    readonly endpoints?: {
        /** Override for the session resource path. */
        readonly session?: string;

        /** Override for the user resource path. */
        readonly user?: string;
    };

    /** Convert a wire timestamp to epoch milliseconds; return null for unparseable values. Defaults to parsing `YYYY-MM-DD HH:MM:SS` as UTC. */
    readonly parseTimestamp?: (value: string) => number | null;

    /** Unwrap the response envelope. Defaults to unwrapping `{ data }` and throwing when the envelope is absent or malformed. */
    readonly unwrap?: (payload: unknown) => unknown;

    /** Map the unwrapped user payload onto U. This is the adaptation point for APIs that shape the user record differently. Defaults to mapping id, email, first plus last name, and permissions, with a non-array permissions field collapsing to an empty list. */
    readonly mapUser?: (payload: unknown) => U;
}

/**
 * Create a {@link SessionApi} over the application HTTP client.
 *
 * The refresh request is sent with `retryOnUnauthorized: false` so a failed
 * refresh cannot recurse back into the unauthorized handler, and with
 * `notifyOnError: false` because a failed background refresh surfaces through
 * the session-loss flow, not a generic error toast.
 *
 * @param http - the HTTP client used to reach the session endpoints
 * @param options - overrides for the organisation's wire conventions
 * @returns the session API gateway
 */
export function createDefaultSessionApi<U extends SessionUser = SessionUser>(
    http: HttpClient,
    options: DefaultSessionApiOptions<U> = {},
): SessionApi<U> {
    const sessionEndpoint = options.endpoints?.session ?? DEFAULT_SESSION_ENDPOINT;
    const userEndpoint = options.endpoints?.user ?? DEFAULT_USER_ENDPOINT;
    const parseTimestamp = options.parseTimestamp ?? parseWireTimestamp;
    const unwrap = options.unwrap ?? unwrapDataEnvelope;
    const mapUser = options.mapUser ?? (mapDefaultUser as (payload: unknown) => U);

    /**
     * Validate an unwrapped session payload and normalise it onto
     * {@link SessionTokens}.
     *
     * @param payload - the raw response payload
     * @returns the normalised tokens
     * @throws {@link SessionError} when the payload does not match the expected
     * shape
     */
    const mapSession = (payload: unknown): SessionTokens => {
        const data = unwrap(payload);

        if (!isRecord(data)) {
            throw new SessionError('The session response did not match the expected shape.');
        }

        const token = data['token'];
        const refreshToken = data['refresh_token'];
        const expiresAt = data['expires_at'];

        if (typeof token !== 'string' || typeof refreshToken !== 'string' || typeof expiresAt !== 'string') {
            throw new SessionError('The session response did not match the expected shape.');
        }

        return { accessToken: token, refreshToken, expiresAtEpochMs: parseTimestamp(expiresAt) };
    };

    return {
        async login(credentials, device): Promise<SessionTokens> {
            const body = { ...credentials, uuid: device.uuid, os: device.os };
            const raw = await http.post<unknown>(sessionEndpoint, body);

            return mapSession(raw);
        },
        async refresh(refreshToken: string): Promise<SessionTokens> {
            const body = wire([['refresh_token', refreshToken]]);
            const raw = await http.patch<unknown>(sessionEndpoint, body, {
                notifyOnError: false,
                retryOnUnauthorized: false,
            });

            return mapSession(raw);
        },
        async logout(): Promise<void> {
            await http.delete(sessionEndpoint);
        },
        async currentUser(): Promise<U> {
            const raw = await http.get<unknown>(userEndpoint);

            return mapUser(unwrap(raw));
        },
    };
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
 * Parse the server's wire-format timestamp (`YYYY-MM-DD HH:MM:SS`) as a UTC
 * instant.
 *
 * The API emits naive timestamps with no offset; this assumes they are always
 * UTC by joining the date and time with `T` and appending `Z` before delegating
 * to `Date.parse`.
 *
 * @param value - the wire-format timestamp
 * @returns the parsed instant in epoch milliseconds, or null when unparseable
 */
function parseWireTimestamp(value: string): number | null {
    const parsed = Date.parse(`${value.replace(' ', 'T')}Z`);

    return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Unwrap the `{ data: {...} }` envelope from a server response.
 *
 * @param payload - the raw response payload
 * @returns the unwrapped data record
 * @throws {@link SessionError} when the envelope is absent or malformed
 */
function unwrapDataEnvelope(payload: unknown): unknown {
    if (!isRecord(payload) || !isRecord(payload['data'])) {
        throw new SessionError('The response did not match the expected envelope shape.');
    }

    return payload['data'];
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
        permissions: mapPermissions(payload['permissions']),
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
 * Extract the flat permission-string list from the raw user payload.
 *
 * @param value - the raw `permissions` field from the user payload
 * @returns the string entries of `value` when it is an array, otherwise an
 * empty array
 */
function mapPermissions(value: unknown): readonly string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.filter((entry): entry is string => typeof entry === 'string');
}
