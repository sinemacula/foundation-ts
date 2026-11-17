/**
 * Toast-notification port; rendering is left to each platform's adapter.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Options accepted by each toast method.
 */
export interface ShowToastOptions {
    /** Auto-dismiss duration in milliseconds; 0 disables it. */
    readonly duration?: number;
}

/**
 * Raises toast notifications.
 */
export interface Toaster {
    /**
     * Raise an error toast.
     *
     * @param message - the message, by convention a translation key
     * @returns the id assigned to the toast
     */
    error(message: string, options?: ShowToastOptions): string;

    /**
     * Raise an informational toast.
     *
     * @param message - the message, by convention a translation key
     * @returns the id assigned to the toast
     */
    information(message: string, options?: ShowToastOptions): string;
}
