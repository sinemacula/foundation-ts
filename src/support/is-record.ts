/**
 * Plain-record type guard.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Determine whether a value is a plain record.
 *
 * @param value - the value to inspect
 * @returns true when the value is a non-null, non-array object
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
