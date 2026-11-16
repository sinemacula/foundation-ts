/**
 * Shared reconnect sequencing for the realtime transport adapters.
 *
 * Every realtime transport adapter reconnects with the same rule: run the
 * optional beforeReconnect hook first, and treat a disconnect that lands while
 * the hook is pending as authoritative once it settles. That shared rule lives
 * here so the adapters cannot drift.
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
 *
 * @returns `false` to skip this attempt
 */
export type BeforeReconnectHook = () => Promise<boolean | undefined> | Promise<void>;

/** The transport-specific callbacks one reconnect attempt drives. */
export interface ReconnectSteps {
    /** The optional pre-reconnect hook, for example a token refresh. */
    readonly beforeReconnect: BeforeReconnectHook | undefined;

    /** Report whether this attempt has been superseded since it began - for example by a disconnect while the hook was still pending. */
    readonly isStale: () => boolean;

    /** Open a fresh transport. A throw is contained: it is passed to `onError` and the next attempt is scheduled. */
    readonly reopen: () => void;

    /** Schedule another reconnect attempt after backoff. */
    readonly reschedule: () => void;

    /** Optional sink for an error thrown while reopening the transport. */
    readonly onError?: (error: unknown) => void;
}

/**
 * Run one reconnect attempt, awaiting the optional beforeReconnect hook first.
 *
 * Staleness is re-checked once the hook settles, so a disconnect that landed
 * while it was pending leaves no trace. Without a hook the transport reopens
 * synchronously.
 *
 * @param steps - the transport-specific reconnect callbacks
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
