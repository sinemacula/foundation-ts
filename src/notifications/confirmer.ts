/**
 * Confirmation-dialog port.
 *
 * The imperative surface the kernel uses to ask for confirmation. The reactive
 * active-request state + host rendering are a web concern and stay in the web
 * adapter.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A confirmation request. `title`, `message`, and the labels are, by
 * convention, translation keys the rendering host translates.
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
     * @param request - the confirmation request
     * @returns a promise resolving true when confirmed, false when cancelled
     */
    confirm(request: ConfirmRequest): Promise<boolean>;
}
