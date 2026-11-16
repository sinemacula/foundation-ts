/**
 * Abort scope for one request-and-body exchange.
 *
 * Composes the caller's signal with the configured timeout and records whether
 * the timeout aborted the exchange.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * The abort signal governing one exchange, composing the caller's signal with
 * the configured timeout.
 */
export interface AbortScope {
    /** The signal to hand to fetch, or null when neither a timeout nor a caller signal applies. */
    readonly signal: AbortSignal | null;

    /**
     * Report whether the configured timeout, rather than the caller, aborted
     * the exchange.
     *
     * @returns true once the timeout has fired
     */
    timedOut(): boolean;

    /**
     * Clear the timeout and detach from the caller's signal.
     */
    dispose(): void;
}

/**
 * Open the abort scope for one exchange. The timeout uses a plain controller
 * and timer rather than `AbortSignal.timeout`/`AbortSignal.any`, which some
 * runtimes (React Native, older Safari) lack.
 *
 * @param timeout - the configured timeout in milliseconds, or null for none
 * @param callerSignal - the caller's signal, if any
 * @returns the scope; dispose it once the body has been read
 */
export function openAbortScope(timeout: number | null, callerSignal: AbortSignal | undefined): AbortScope {
    if (timeout === null) {
        return { signal: callerSignal ?? null, timedOut: () => false, dispose: () => undefined };
    }

    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
        if (!controller.signal.aborted) {
            timedOut = true;
            controller.abort();
        }
    }, timeout);

    const detach = onAbort(callerSignal, reason => {
        controller.abort(reason);
    });

    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        dispose: () => {
            clearTimeout(timer);
            detach();
        },
    };
}

/**
 * Run a listener when a signal aborts: at once when it already has, otherwise
 * on its abort event.
 *
 * @param signal - the signal to watch, if any
 * @param listener - receives the signal's abort reason
 * @returns a function that stops watching the signal
 */
export function onAbort(signal: AbortSignal | undefined, listener: (reason: unknown) => void): () => void {
    if (signal === undefined) {
        return () => undefined;
    }

    if (signal.aborted) {
        listener(signal.reason);

        return () => undefined;
    }

    /**
     * Forward the abort reason to the listener.
     */
    const forward = (): void => {
        listener(signal.reason);
    };

    signal.addEventListener('abort', forward);

    return () => {
        signal.removeEventListener('abort', forward);
    };
}
