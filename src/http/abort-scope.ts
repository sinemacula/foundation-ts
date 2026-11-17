/**
 * Abort scope for one request-and-body exchange.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/** What aborted an exchange: the caller's signal, the timeout, or nothing. */
export type AbortSource = 'caller' | 'timeout' | 'none';

/**
 * The abort signal governing one exchange, and the record of what aborted it,
 * so a failure is classified by its source rather than by its error name.
 */
export interface AbortScope {
    /** The signal to hand to fetch, or null without a timeout or caller signal. */
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
 * Open the abort scope for one exchange, timing out with a plain controller and
 * timer since some runtimes (React Native, older Safari) lack
 * `AbortSignal.timeout` and `AbortSignal.any`.
 *
 * @param timeout - the timeout in milliseconds, or null for none
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
 * Run a listener once when a signal aborts: at once when it already has,
 * otherwise on its abort event, detaching before the listener runs.
 *
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
     * Detach, then forward the abort reason to the listener.
     */
    const forward = (): void => {
        signal.removeEventListener('abort', forward);
        listener(signal.reason);
    };

    signal.addEventListener('abort', forward);

    return () => {
        signal.removeEventListener('abort', forward);
    };
}

/**
 * Settle with a promise unless a signal aborts first, in which case reject at
 * once without waiting. The promise is always observed, so a rejection after
 * the abort is never unhandled, and the abort listener is released on whichever
 * happens first.
 *
 * @param toError - maps the abort reason onto the rejection
 */
export function untilAborted<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
    toError: (reason: unknown) => Error,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const detach = onAbort(signal, reason => {
            reject(toError(reason));
        });

        promise.then(
            value => {
                detach();
                resolve(value);
            },
            (error: unknown) => {
                detach();
                reject(error);
            },
        );
    });
}
