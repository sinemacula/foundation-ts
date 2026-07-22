/**
 * Loader for a runtime environment document.
 *
 * Fetches a JSON document of environment values at boot and keeps only its
 * string-valued entries. Every failure mode (missing document, network error,
 * malformed payload) resolves to an empty record so the environment chain falls
 * through to the platform's build-time variables. Where the document lives is
 * the caller's concern; each kernel supplies its own URL convention.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Fetch and normalise the runtime environment document.
 *
 * @param fetchFn - the fetch implementation to use
 * @param url - the document location
 * @returns the string-valued entries of the document, or an empty record
 */
export async function fetchRuntimeEnvironment(
    fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init),
    url: string,
): Promise<Record<string, string>> {
    try {
        const response = await fetchFn(url, { cache: 'no-store', headers: { accept: 'application/json' } });

        if (!response.ok) {
            return {};
        }

        return normaliseRuntimeValues(await response.json());
    } catch {
        return {};
    }
}

/**
 * Keep only the string-valued entries of a parsed payload.
 *
 * @param payload - the parsed JSON payload
 * @returns the string-valued entries, or an empty record for non-objects
 */
function normaliseRuntimeValues(payload: unknown): Record<string, string> {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return {};
    }

    const values: Record<string, string> = {};

    for (const [key, value] of Object.entries(payload)) {
        if (typeof value === 'string') {
            values[key] = value;
        }
    }

    return values;
}
