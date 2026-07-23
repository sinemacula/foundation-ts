/**
 * Session route identity.
 *
 * One configurable source feeding the guards, the session-loss redirect, and
 * the redirect sanitiser's loop guard. Generic over the platform's route
 * location type; each kernel binds it to its own router vocabulary.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Route identity - one configurable source feeding the guards, the session-loss
 * redirect, and the redirect sanitiser's loop guard.
 */
export interface SessionRoutes<L> {
    /** Where unauthenticated visitors are sent. */
    readonly login: L;

    /** The login-path prefix rejected by the redirect sanitiser as a loop guard. Applications renaming the login path set `login` and `loginPath` together. */
    readonly loginPath: string;

    /** Where authenticated visitors leaving guest-only routes are sent. */
    readonly home: L;

    /** Where authenticated-but-unauthorised visitors are sent. */
    readonly forbidden: L;
}
