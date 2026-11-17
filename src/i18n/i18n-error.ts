/**
 * Error type for the internationalisation layer.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Raised when a locale cannot be activated, such as an unknown locale or a
 * module name colliding with a shared top-level translation key.
 */
export class I18nError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'I18nError';
    }
}
