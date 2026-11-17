/**
 * Reconnect sequencing shared by the realtime transport adapters.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Awaited before each reconnect attempt opens a fresh transport.
 *
 * Resolving `false` or rejecting skips the attempt and reschedules it through
 * backoff; any other result proceeds. Map a classified refresh explicitly:
 *
 * `async () => (await coordinator.refresh()).kind === 'refreshed'`
 *
 * On a terminal outcome (sign-out, pending authentication) call `disconnect()`
 * instead of skipping attempts.
 */
export type BeforeReconnectHook = () => Promise<boolean | undefined> | Promise<void>;

/** The transport-specific callbacks one reconnect attempt drives. */
export interface ReconnectSteps {
    /** The optional pre-reconnect hook, for example a token refresh. */
    readonly beforeReconnect: BeforeReconnectHook | undefined;

    /** Whether this attempt has been superseded, for example by a disconnect. */
    readonly isStale: () => boolean;

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
 * Staleness is checked after the hook settles, so a disconnect that landed
 * while it was pending wins. Without a hook the transport reopens
 * synchronously.
 */
export async function runReconnect(steps: ReconnectSteps): Promise<void> {
    let proceed = true;

    if (steps.beforeReconnect !== undefined) {
        try {
            proceed = (await steps.beforeReconnect()) !== false;
        } catch {
            proceed = false;
        }
    }

    if (steps.isStale()) {
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
