/**
 * Reconnect sequencing shared by the realtime transport adapters.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/** How long in milliseconds a transport must stay open to reset the backoff. */
export const STABLE_CONNECTION_MS = 5_000;

/**
 * Awaited before each reconnect attempt opens a fresh transport.
 *
 * Resolving `false` or rejecting skips the attempt and reschedules it through
 * backoff; any other result proceeds. `signal` aborts when the connection is
 * disconnected, so a hook that resumes after a disconnect, or after the
 * connection was cycled by a newer owner, must not act on its outcome. Map a
 * classified refresh explicitly:
 *
 * ```ts
 * async signal => {
 *     const outcome = await coordinator.refresh();
 *
 *     if (signal.aborted) {
 *         return false;
 *     }
 *
 *     switch (outcome.kind) {
 *         case 'refreshed':
 *             return true;
 *         case 'retryable':
 *         case 'superseded':
 *             return false;
 *         case 'failed':
 *             reporter.captureError(outcome.error);
 *
 *             if (!signal.aborted) {
 *                 connection.disconnect();
 *             }
 *
 *             return false;
 *         case 'rejected':
 *         case 'interactionRequired':
 *             connection.disconnect();
 *
 *             return false;
 *     }
 * }
 * ```
 *
 * A terminal outcome reflects session ownership when it was classified, so a
 * kernel also guards against its session owner being replaced meanwhile.
 */
export type BeforeReconnectHook = (signal: AbortSignal) => Promise<boolean | undefined> | Promise<void>;

/** The transport-specific callbacks one reconnect attempt drives. */
export interface ReconnectSteps {
    /** The optional pre-reconnect hook, for example a token refresh. */
    readonly beforeReconnect: BeforeReconnectHook | undefined;

    /** Aborted once this attempt is superseded, for example by a disconnect. */
    readonly signal: AbortSignal;

    /** Open a fresh transport; a throw goes to `onError` and reschedules. */
    readonly reopen: () => void;

    /** Schedule another reconnect attempt after backoff. */
    readonly reschedule: () => void;

    /** Optional sink for an error thrown while reopening the transport. */
    readonly onError?: (error: unknown) => void;
}

/**
 * Run one reconnect attempt, awaiting the optional beforeReconnect hook first.
 *
 * The signal is checked after the hook settles, so a disconnect that landed
 * while it was pending wins. Without a hook the transport reopens
 * synchronously.
 */
export async function runReconnect(steps: ReconnectSteps): Promise<void> {
    let proceed = true;

    if (steps.beforeReconnect !== undefined) {
        try {
            proceed = (await steps.beforeReconnect(steps.signal)) !== false;
        } catch {
            proceed = false;
        }
    }

    if (steps.signal.aborted) {
        return;
    }

    if (!proceed) {
        steps.reschedule();

        return;
    }

    try {
        steps.reopen();
    } catch (error) {
        steps.reschedule();
        steps.onError?.(error);
    }
}
