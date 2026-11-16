/**
 * Abort scope for one request-and-body exchange.
 *
 * Composes the caller's signal with the configured timeout and records which of
 * them aborted the exchange, so a failure is classified by its actual source
 * rather than by the name of the error it surfaced as.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/** What aborted an exchange: the caller's signal, the timeout, or nothing. */
export type AbortSource = 'caller' | 'timeout' | 'none';

/**
 * The abort signal governing one exchange, and the record of what aborted it.
 */
export interface AbortScope {
    /** The signal to hand to fetch, or null when neither a timeout nor a caller signal applies. */
    readonly signal: AbortSignal | null;

    /**
     * Report what aborted the exchange.
     *
     * @returns the first source to abort, or `none` while nothing has
     */
    source(): AbortSource;

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
        return {
            signal: callerSignal ?? null,
            source: () => (callerSignal?.aborted === true ? 'caller' : 'none'),
            dispose: () => undefined,
        };
    }

    const controller = new AbortController();
    let source: AbortSource = 'none';

    /**
     * Abort the exchange on behalf of the first source to fire.
     *
     * @param by - the source aborting the exchange
     * @param reason - the abort reason, or undefined for the default
     */
    const abort = (by: Exclude<AbortSource, 'none'>, reason?: unknown): void => {
        if (source === 'none') {
            source = by;
            controller.abort(reason);
        }
    };

    const timer = setTimeout(() => {
        abort('timeout');
    }, timeout);

    const detach = onAbort(callerSignal, reason => {
        abort('caller', reason);
    });

    return {
        signal: controller.signal,
        source: () => source,
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
