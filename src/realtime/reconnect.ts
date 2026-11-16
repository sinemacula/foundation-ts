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

/** The transport-specific callbacks one reconnect attempt drives. */
export interface ReconnectSteps {
    /** The optional pre-reconnect hook, for example a token refresh. */
    readonly beforeReconnect: (() => Promise<void>) | undefined;

    /** Report whether this attempt has been superseded since it began - for example by a disconnect while the hook was still pending. */
    readonly isStale: () => boolean;

    /** Open a fresh transport. */
    readonly reopen: () => void;

    /** Schedule another reconnect attempt after backoff. */
    readonly reschedule: () => void;
}

/**
 * Run one reconnect attempt, awaiting the optional beforeReconnect hook first.
 *
 * A disconnect that lands while the hook is pending must leave no trace once it
 * settles, so staleness is re-checked before reopening or rescheduling. A
 * closed-state check is not enough: a disconnect followed by a fresh connect
 * leaves the connection open again, so the attempt tracks a generation token
 * that the disconnect advances rather than reading the live state.
 *
 * @param steps - the transport-specific reconnect callbacks
 */
export async function runReconnect(steps: ReconnectSteps): Promise<void> {
    if (steps.beforeReconnect === undefined) {
        steps.reopen();

        return;
    }

    try {
        await steps.beforeReconnect();
    } catch {
        if (!steps.isStale()) {
            steps.reschedule();
        }

        return;
    }

    if (!steps.isStale()) {
        steps.reopen();
    }
}
