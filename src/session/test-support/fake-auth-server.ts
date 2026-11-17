/**
 * In-memory authentication server for session tests: rotation, grace, replay,
 * supersession and sign-out as the authentication package applies them.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { HttpError } from '../../http/http-error';
import type { PasswordCredentials, SessionApi } from '../session-api';
import type { RefreshResult } from '../session-outcomes';
import { classifyRefreshError } from '../session-outcomes';
import type { SessionTokens } from '../session-tokens';
import type { SessionUser } from '../session-user';

/** Why the server revoked a session. */
export type FakeRevocationReason = 'signed_out' | 'rotation_reuse' | 'superseded';

/** A request the fake serves. */
export type FakeAuthOperation = 'login' | 'refresh' | 'logout' | 'currentUser';

/** Options for {@link FakeAuthServer}. */
export interface FakeAuthServerOptions {
    /** The clock, in epoch milliseconds. */
    readonly now: () => number;

    /** How long the previous rotation id still refreshes after a rotation. Default 30 000; 0 makes it a replay. */
    readonly graceMs?: number;

    /** How long an access token lives. Default 900 000. */
    readonly accessTtlMs?: number;

    /** How the refresh token travels: in the body, or in the shared cookie jar. Default 'body'. */
    readonly transport?: 'body' | 'cookie';

    /** The password every identity signs in with. Default 'secret'. */
    readonly password?: string;
}

/** Options for one context's gateway over the fake. */
export interface FakeAuthApiOptions {
    /** The bearer token the context's authenticated requests carry when sent. */
    readonly accessToken: () => string | null;

    /** Awaited before each request is sent, so a test can hold or schedule it. */
    readonly before?: (operation: FakeAuthOperation) => Promise<void>;
}

/** A server-side session, as it stands. */
export interface FakeServerSession {
    /** The session id. */
    readonly id: string;

    /** The identity the session belongs to. */
    readonly owner: string;

    /** The current rotation id. */
    readonly rotation: number;

    /** The rotation id the current one replaced, or null. */
    readonly previous: number | null;

    /** When the session last rotated, or null. */
    readonly rotatedAt: number | null;

    /** Why the session was revoked, or null while it is live. */
    readonly revoked: FakeRevocationReason | null;
}

/** A request the fake served, with the credentials it carried. */
export interface FakeAuthRequest {
    /** What was asked. */
    readonly operation: FakeAuthOperation;

    /** The bearer token sent, or null. */
    readonly bearer: string | null;

    /** The refresh credential sent, from the body or the cookie jar, or null. */
    readonly refreshToken: string | null;
}

/** A refresh token's session and the rotation it names. */
interface Proven {
    /** The session. */
    readonly record: SessionRecord;

    /** The rotation id the token carries. */
    readonly rotation: number;
}

/** A refresh token judged acceptable. */
interface Judgement {
    /** The session. */
    readonly record: SessionRecord;

    /** Whether the token carries the current rotation, rather than the previous one inside the grace window. */
    readonly current: boolean;
}

/** A mutable server-side session. */
type SessionRecord = { -readonly [K in keyof FakeServerSession]: FakeServerSession[K] };

/** An issued access token. */
interface AccessGrant {
    /** The session the token belongs to. */
    readonly session: string;

    /** When the token expires. */
    readonly expiresAt: number;
}

const REFRESH_TOKEN = /^refresh-(s\d+)-(\d+)$/u;

/**
 * Serve the session endpoints from memory. Sign-in, refresh and sign-out
 * responses set or delete the refresh cookie in one jar every context shares;
 * refusals are `HttpError(401)`, and a wrong password `HttpError(422)`.
 */
export class FakeAuthServer {
    /** Every request served, in order. */
    readonly requests: FakeAuthRequest[] = [];

    /** The sessions, by id. */
    readonly #sessions = new Map<string, SessionRecord>();

    /** The issued access tokens. */
    readonly #grants = new Map<string, AccessGrant>();

    /** The clock. */
    readonly #now: () => number;

    /** The grace window, in milliseconds. */
    readonly #graceMs: number;

    /** The access token lifetime, in milliseconds. */
    readonly #accessTtlMs: number;

    /** Whether the refresh token travels in the cookie jar. */
    readonly #cookie: boolean;

    /** The password every identity signs in with. */
    readonly #password: string;

    /** The refresh cookie the shared jar holds, or null. */
    #jar: string | null = null;

    /** The last id issued, for sessions, rotations and access tokens. */
    #sequence = 0;

    constructor(options: FakeAuthServerOptions) {
        this.#now = options.now;
        this.#graceMs = options.graceMs ?? 30_000;
        this.#accessTtlMs = options.accessTtlMs ?? 900_000;
        this.#cookie = options.transport === 'cookie';
        this.#password = options.password ?? 'secret';
    }

    /**
     * The refresh cookie the shared jar holds, or null.
     */
    get cookie(): string | null {
        return this.#jar;
    }

    /**
     * Read a session as it stands.
     */
    session(id: string): FakeServerSession | undefined {
        const record = this.#sessions.get(id);

        return record === undefined ? undefined : { ...record };
    }

    /**
     * Read every session, in the order they were created.
     */
    sessions(): FakeServerSession[] {
        return [...this.#sessions.values()].map(record => ({ ...record }));
    }

    /**
     * Resolve the live session an access token belongs to.
     *
     * @returns the session, or undefined when the token is unknown, expired or
     * its session revoked
     */
    sessionOf(accessToken: string | null): FakeServerSession | undefined {
        const record = this.#bearer(accessToken);

        return record === undefined ? undefined : { ...record };
    }

    /**
     * Resolve the session an access token was issued for, live or not.
     */
    issuerOf(accessToken: string | null): FakeServerSession | undefined {
        const grant = accessToken === null ? undefined : this.#grants.get(accessToken);
        const record = grant === undefined ? undefined : this.#sessions.get(grant.session);

        return record === undefined ? undefined : { ...record };
    }

    /**
     * Build one context's gateway over the server.
     */
    api(options: FakeAuthApiOptions): SessionApi<SessionUser, PasswordCredentials> {
        /** Send a request once the context lets it go, then serve it. */
        const send = async <T>(
            operation: FakeAuthOperation,
            credentials: (jar: string | null) => Omit<FakeAuthRequest, 'operation'>,
            serve: (request: FakeAuthRequest) => T,
        ): Promise<T> => {
            await options.before?.(operation);

            const request = { operation, ...credentials(this.#jar) };

            this.requests.push(request);

            return serve(request);
        };

        return {
            login: (credentials, _device, refreshToken) =>
                send(
                    'login',
                    jar => ({ bearer: null, refreshToken: this.#cookie ? jar : refreshToken }),
                    request => ({ kind: 'authenticated', tokens: this.#signIn(credentials, request.refreshToken) }),
                ),
            refresh: async (refreshToken): Promise<RefreshResult> => {
                try {
                    const tokens = await send(
                        'refresh',
                        jar => ({ bearer: null, refreshToken: this.#cookie ? jar : refreshToken }),
                        request => this.#refresh(request.refreshToken),
                    );

                    return { kind: 'refreshed', tokens };
                } catch (error) {
                    return { kind: classifyRefreshError(error), error };
                }
            },
            logout: tokens =>
                send(
                    'logout',
                    jar => ({ bearer: tokens.accessToken, refreshToken: this.#cookie ? jar : tokens.refreshToken }),
                    request => {
                        this.#signOut(request);
                    },
                ),
            currentUser: () =>
                send(
                    'currentUser',
                    () => ({ bearer: options.accessToken(), refreshToken: null }),
                    request => this.#user(request.bearer),
                ),
        };
    }

    /**
     * Start a session, superseding the one the presented token proves when it
     * is that session's current token and the same identity's.
     */
    #signIn(credentials: PasswordCredentials, presented: string | null): SessionTokens {
        if (credentials.password !== this.#password) {
            throw new HttpError(422, 'The credentials are incorrect.');
        }

        const proven = this.#parse(presented);

        if (
            proven !== undefined &&
            proven.record.revoked === null &&
            proven.record.owner === credentials.email &&
            proven.rotation === proven.record.rotation
        ) {
            proven.record.revoked = 'superseded';
        }

        const id = `s${String(this.#next())}`;
        const record: SessionRecord = {
            id,
            owner: credentials.email,
            rotation: this.#next(),
            previous: null,
            rotatedAt: null,
            revoked: null,
        };

        this.#sessions.set(id, record);

        return this.#issue(record);
    }

    /**
     * Rotate the session the presented token proves, or answer a grace retry
     * with its current rotation.
     */
    #refresh(presented: string | null): SessionTokens {
        const { record, current } = this.#judge(presented);

        if (current) {
            record.previous = record.rotation;
            record.rotation = this.#next();
            record.rotatedAt = this.#now();
        }

        return this.#issue(record);
    }

    /**
     * Sign out by a live bearer token, else by the refresh credential; a cookie
     * sign-out deletes the cookie either way.
     */
    #signOut(request: FakeAuthRequest): void {
        const bound = this.#bearer(request.bearer);

        if (this.#cookie) {
            this.#jar = null;
        }

        if (bound !== undefined) {
            bound.revoked = 'signed_out';

            return;
        }

        this.#judge(request.refreshToken).record.revoked = 'signed_out';
    }

    /**
     * Resolve the user of the session a live bearer token belongs to.
     */
    #user(bearer: string | null): SessionUser {
        const record = this.#bearer(bearer);

        if (record === undefined) {
            throw refused();
        }

        return { id: record.owner, email: record.owner, name: null, permissions: [] };
    }

    /**
     * Judge a presented refresh token: its session's current rotation, or the
     * previous one inside the grace window. Any other rotation is a replay,
     * which revokes the session.
     *
     * @throws {@link HttpError} when the token is refused
     */
    #judge(presented: string | null): Judgement {
        const proven = this.#parse(presented);

        if (proven === undefined || proven.record.revoked !== null) {
            throw refused();
        }

        const { record, rotation } = proven;

        if (rotation === record.rotation) {
            return { record, current: true };
        }

        if (
            rotation === record.previous &&
            record.rotatedAt !== null &&
            this.#now() - record.rotatedAt < this.#graceMs
        ) {
            return { record, current: false };
        }

        record.revoked = 'rotation_reuse';

        throw refused();
    }

    /**
     * Resolve the session and rotation a refresh token names.
     */
    #parse(token: string | null): Proven | undefined {
        const match = token === null ? null : REFRESH_TOKEN.exec(token);
        const record = match === null ? undefined : this.#sessions.get(match[1] ?? '');

        return record === undefined ? undefined : { record, rotation: Number(match?.[2]) };
    }

    /**
     * Resolve the live session a bearer token belongs to.
     */
    #bearer(token: string | null): SessionRecord | undefined {
        const grant = token === null ? undefined : this.#grants.get(token);
        const record = grant === undefined ? undefined : this.#sessions.get(grant.session);

        return record?.revoked === null && grant !== undefined && this.#now() < grant.expiresAt ? record : undefined;
    }

    /**
     * Issue an access token and the current refresh token, setting the cookie
     * when the refresh token travels in it.
     */
    #issue(record: SessionRecord): SessionTokens {
        const accessToken = `access-${record.id}-${String(this.#next())}`;
        const expiresAt = this.#now() + this.#accessTtlMs;
        const refreshToken = `refresh-${record.id}-${String(record.rotation)}`;

        this.#grants.set(accessToken, { session: record.id, expiresAt });

        if (this.#cookie) {
            this.#jar = refreshToken;
        }

        return { accessToken, refreshToken: this.#cookie ? null : refreshToken, expiresAtEpochMs: expiresAt };
    }

    /**
     * Issue the next id.
     */
    #next(): number {
        this.#sequence += 1;

        return this.#sequence;
    }
}

/**
 * Build the refusal the server answers with.
 */
function refused(): HttpError {
    return new HttpError(401, 'Unauthenticated.');
}
