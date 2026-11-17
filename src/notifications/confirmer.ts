/**
 * Confirmation-dialog port; rendering is left to each platform's adapter.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A confirmation request whose strings are translation keys.
 */
export interface ConfirmRequest {
    /** Translation key for the dialog title. */
    readonly title: string;

    /** Translation key for the dialog message. */
    readonly message: string;

    /** Translation key for the confirm button label. */
    readonly confirmLabel?: string;

    /** Translation key for the cancel button label. */
    readonly cancelLabel?: string;
}

/**
 * Asks the user to confirm an action.
 */
export interface Confirmer {
    /**
     * Ask the user to confirm.
     *
     * @returns a promise resolving true when confirmed, false when cancelled
     */
    confirm(request: ConfirmRequest): Promise<boolean>;
}
