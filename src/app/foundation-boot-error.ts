/**
 * Foundation boot failure.
 *
 * Thrown when the kernel is asked to boot with an option combination that
 * cannot work, so misconfiguration surfaces loudly at boot instead of silently
 * producing an application with missing behaviour.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * An invalid boot option combination.
 */
export class FoundationBootError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FoundationBootError';
    }
}
