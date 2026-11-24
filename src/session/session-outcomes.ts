/**
 * Sign-in and refresh results, core outcomes, and the refresh-failure policy.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { ApiErrorCode, CancelledError, HttpError, NetworkError } from '../http/http-error';
import type { SessionTokens } from './session-tokens';

/**
 * A session that needs a further step (such as a second factor) before it is
 * issued tokens.
 */
export interface PendingAuthentication {
    /** The pending credential the further step is completed with. */
    readonly credential: string;

    /** What the session still requires, such as `mfa`. */
    readonly requires: readonly string[];
}

/**
 * How a failed refresh is treated.
 *
 * - `rejected`: the server refused the refresh credential; the session is dead
 * - `retryable`: a transient failure; the tokens are kept and a later attempt
 *   may succeed
 * - `failed`: a non-transient failure that is not a refusal (a misconfiguration
 *   or a malformed response); the tokens are kept, the error is surfaced, and
 *   retrying is pointless
 */
export type RefreshFailureKind = 'rejected' | 'retryable' | 'failed';

/**
 * A gateway's answer to a sign-in.
 */
export type LoginResult =
    | {
          /** The sign-in issued tokens. */
          readonly kind: 'authenticated';

          /** The issued tokens. */
          readonly tokens: SessionTokens;
      }
    | {
          /** The sign-in needs a further step before it issues tokens. */
          readonly kind: 'interactionRequired';

          /** The pending session. */
          readonly pending: PendingAuthentication;
      };

/**
 * A gateway's answer to a refresh.
 */
export type RefreshResult =
    | {
          /** The refresh issued tokens. */
          readonly kind: 'refreshed';

          /** The issued tokens. */
          readonly tokens: SessionTokens;
      }
    | {
          /** The session returned to pending and needs a further step. */
          readonly kind: 'interactionRequired';

          /** The pending session. */
          readonly pending: PendingAuthentication;
      }
    | {
          /** How the failure is treated. */
          readonly kind: RefreshFailureKind;

          /** The underlying failure. */
          readonly error: unknown;
      };

/**
 * What a sign-in through the session core did.
 */
export type LoginOutcome =
    | {
          /** The session is established, persisted, and its user loaded. */
          readonly kind: 'authenticated';
      }
    | {
          /** Nothing was persisted; the pending session needs a further step. */
          readonly kind: 'interactionRequired';

          /** The pending session. */
          readonly pending: PendingAuthentication;
      }
    | {
          /** Another session transition overtook this sign-in, whose session was discarded. */
          readonly kind: 'superseded';
      };

/**
 * What a refresh through the session core did.
 *
 * - `refreshed`: the state still holds the session the refresh started on,
 *   rotated and persisted, or rotated by another context and adopted
 * - `rejected`: the session was cleared
 * - `retryable`: the tokens are kept
 * - `failed`: the tokens are kept when the refresh failed or a rotated pair
 *   could not be persisted (the next transition retries persisting it), and
 *   discarded when a refused session could not be cleared from persistence
 * - `interactionRequired`: the session was cleared and the pending session is
 *   handed back
 * - `superseded`: the state held no session, or the one the refresh started on
 *   was replaced or signed out meanwhile, by this context or by adopting
 *   another context's session, and the result discarded
 */
export type RefreshOutcome =
    | {
          /** The state still holds the session the refresh started on. */
          readonly kind: 'refreshed';
      }
    | {
          /** The session returned to pending and needs a further step. */
          readonly kind: 'interactionRequired';

          /** The pending session. */
          readonly pending: PendingAuthentication;
      }
    | {
          /** How the failure was treated. */
          readonly kind: RefreshFailureKind;

          /** The underlying failure. */
          readonly error: unknown;
      }
    | {
          /** The refresh did not apply to the session the state holds. */
          readonly kind: 'superseded';
      };

/**
 * Classify a failed refresh request.
 *
 * A 401 is the server refusing the refresh credential. A transport failure
 * (including a timeout), a cancellation, a 408, a 429, and any 5xx are
 * transient. Everything else (a 403 cross-site refusal, a 422, any other 4xx, a
 * malformed response) is a non-transient failure that leaves the session in
 * place.
 *
 * @param error - the failure thrown by the refresh request
 */
export function classifyRefreshError(error: unknown): RefreshFailureKind {
    if (error instanceof NetworkError || error instanceof CancelledError) {
        return 'retryable';
    }

    if (!(error instanceof HttpError)) {
        return 'failed';
    }

    if (error.status === 401) {
        return 'rejected';
    }

    return error.status === 408 || error.status === 429 || error.status >= 500 ? 'retryable' : 'failed';
}

/**
 * Whether a refresh was refused because the request carried no refresh cookie,
 * as when the browser blocks the API's cookie or it was cleared. The refusal is
 * still `rejected`; only the cookie transport produces it.
 *
 * @param error - the failure a rejected refresh carries
 */
export function isRefreshCookieMissing(error: unknown): boolean {
    return error instanceof HttpError && error.status === 401 && error.code === ApiErrorCode.RefreshCookieMissing;
}
