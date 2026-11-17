/**
 * Thrown when the kernel boots with an option combination that cannot work.
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
