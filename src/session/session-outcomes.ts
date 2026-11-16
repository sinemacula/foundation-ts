/**
 * Session outcomes.
 *
 * The results a {@link SessionApi} gateway returns for sign-in and refresh, the
 * outcomes the session core reports to its callers, and the default policy
 * classifying a failed refresh. Callers branch on `kind` rather than on raw
 * transport errors, so a proactive refresh timer can tell a dead session from a
 * transient failure worth retrying.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { CancelledError, HttpError, NetworkError } from '../http/http-error';
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
          /** A later sign-in, sign-out, or hydration overtook this sign-in, whose session was discarded. */
          readonly kind: 'superseded';
      };

/**
 * What a refresh through the session core did.
 *
 * `refreshed` means the state holds a usable session, either newly issued and
 * persisted or adopted from persisted state another context wrote. `rejected`
 * means the session was cleared. `retryable` and `failed` keep the tokens.
 * `interactionRequired` keeps the tokens and hands back the pending session.
 * `superseded` means a sign-out, sign-in, or hydration overtook the refresh,
 * whose result was discarded.
 */
export type RefreshOutcome =
    | {
          /** The state holds a usable session. */
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
          /** Another session transition overtook the refresh. */
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
 * @returns how the failure is treated
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
