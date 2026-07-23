/**
 * Toast-notification port.
 *
 * The imperative surface the kernel uses to raise toasts, plus the options the
 * per-variant methods accept. The reactive toast queue + host rendering are a
 * platform concern and stay in each platform's adapter.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Options accepted by the per-show methods.
 */
export interface ShowToastOptions {
    /** Auto-dismiss duration in milliseconds; 0 disables it. */
    readonly duration?: number;
}

/**
 * Raises toast notifications. `message` is by convention a translation key.
 */
export interface Toaster {
    /**
     * Raise an error toast.
     *
     * @param message - the message, by convention a translation key
     * @param options - optional show options
     * @returns the id assigned to the toast
     */
    error(message: string, options?: ShowToastOptions): string;

    /**
     * Raise an informational toast.
     *
     * @param message - the message, by convention a translation key
     * @param options - optional show options
     * @returns the id assigned to the toast
     */
    information(message: string, options?: ShowToastOptions): string;
}
