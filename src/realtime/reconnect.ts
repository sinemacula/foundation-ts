/**
 * Shared reconnect sequencing for the realtime transport adapters.
 *
 * Both the EventSource and WebSocket adapters reconnect with the same rule: run
 * the optional beforeReconnect hook first, and treat a disconnect that lands
 * while the hook is pending as authoritative once it settles. That shared rule
 * lives here so the two adapters cannot drift.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/** The transport-specific callbacks one reconnect attempt drives. */
export interface ReconnectSteps {
    /** The optional pre-reconnect hook, for example a token refresh. */
    readonly beforeReconnect: (() => Promise<void>) | undefined;

    /** Report whether the connection has since been closed. */
    readonly isClosed: () => boolean;

    /** Open a fresh transport. */
    readonly reopen: () => void;

    /** Schedule another reconnect attempt after backoff. */
    readonly reschedule: () => void;
}

/**
 * Run one reconnect attempt, awaiting the optional beforeReconnect hook first.
 *
 * A disconnect that lands while the hook is pending must leave no trace once it
 * settles, so the closed state is re-checked before reopening or rescheduling.
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
        if (!steps.isClosed()) {
            steps.reschedule();
        }

        return;
    }

    if (!steps.isClosed()) {
        steps.reopen();
    }
}
