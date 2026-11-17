/**
 * Loader for the runtime environment document fetched at boot.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { isRecord } from '../support/is-record';
import { MAX_TIMER_DELAY } from '../support/timer';
import { RuntimeEnvironmentError } from './runtime-environment-error';

/** The default allowance for the request and its body, in milliseconds. */
const DEFAULT_TIMEOUT = 5000;

/**
 * Where the runtime environment document lives and how long to wait for it.
 */
export interface RuntimeEnvironmentSource {
    /** The document location. */
    readonly url: string;

    /** Milliseconds allowed for the request and its body together. Default 5000. */
    readonly timeout?: number;
}

/**
 * Fetch the runtime environment document and keep its string-valued entries.
 *
 * Only a 404 counts as absent; any other failure rejects so a deployed but
 * unreadable document never silently falls back to build-time values.
 *
 * @param fetchFn - defaults to the global fetch
 * @returns the string-valued entries of the document, or an empty record when
 * it does not exist
 * @throws {RangeError} when the timeout is not a positive timer delay
 * @throws {RuntimeEnvironmentError} when the document cannot be loaded in time,
 * responds with an error status, or is not a JSON object
 */
export async function fetchRuntimeEnvironment(
    source: RuntimeEnvironmentSource,
    fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<Record<string, string>> {
    const timeout = source.timeout ?? DEFAULT_TIMEOUT;

    if (!(timeout > 0 && timeout <= MAX_TIMER_DELAY)) {
        throw new RangeError(`The runtime environment timeout must be between 1 and ${MAX_TIMER_DELAY} ms.`);
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new RuntimeEnvironmentError(`The runtime environment document did not load within ${timeout} ms.`));
        }, timeout);
    });

    try {
        return await Promise.race([load(source.url, fetchFn, controller.signal), deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Request the document and read its string-valued entries.
 *
 * @param signal - aborts the request once the deadline passes
 * @returns the string-valued entries, or an empty record when it does not exist
 * @throws {RuntimeEnvironmentError} when the document cannot be loaded or is
 * not a JSON object
 */
async function load(url: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<Record<string, string>> {
    let response: Response;

    try {
        response = await fetchFn(url, { cache: 'no-store', headers: { accept: 'application/json' }, signal });
    } catch (error) {
        throw new RuntimeEnvironmentError('The runtime environment document could not be fetched.', { cause: error });
    }

    if (response.status === 404) {
        return {};
    }

    if (!response.ok) {
        throw new RuntimeEnvironmentError(`The runtime environment document responded with ${response.status}.`);
    }

    let payload: unknown;

    try {
        payload = await response.json();
    } catch (error) {
        throw new RuntimeEnvironmentError('The runtime environment document is not valid JSON.', { cause: error });
    }

    if (!isRecord(payload)) {
        throw new RuntimeEnvironmentError('The runtime environment document must be a JSON object.');
    }

    return Object.fromEntries(
        Object.entries(payload).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
}
