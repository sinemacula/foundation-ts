/**
 * Session route identity, generic over the platform's route location type.
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

    /** The path the redirect sanitiser's loop guard rejects, with every path under it; `/` rejects all. Set it with `login`. */
    readonly loginPath: string;

    /** Where authenticated visitors leaving guest-only routes are sent. */
    readonly home: L;

    /** Where authenticated-but-unauthorised visitors are sent. */
    readonly forbidden: L;
}
