/**
 * Error type for the internationalisation layer.
 *
 * Thrown when a locale cannot be activated - an unknown locale is requested, or
 * a module name collides with a shared top-level translation key - so the
 * failure surfaces as a typed error callers can branch on with `instanceof`
 * rather than a bare `Error`.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A locale that could not be activated.
 */
export class I18nError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'I18nError';
    }
}
