/**
 * Session user shape.
 *
 * The minimal user record the kernel session machinery needs; applications
 * extend it through the U generic on {@link SessionApi} and supply their own
 * mapping for any richer shape.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * The authenticated user as seen by the kernel.
 */
export interface SessionUser {
    /** The unique user identifier. */
    readonly id: string | number;

    /** The user's email address; null when not provided. */
    readonly email: string | null;

    /** The user's display name; null when not provided. */
    readonly name: string | null;

    /** The flat list of permission strings granted to the user. */
    readonly permissions: readonly string[];
}
