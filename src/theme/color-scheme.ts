/**
 * Platform-agnostic colour-scheme types and storage key.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A user's colour-scheme choice, including deferring to the OS.
 */
export type ColorSchemePreference = 'light' | 'dark' | 'system';

/**
 * A concrete colour scheme after resolving `system` against the OS.
 */
export type ResolvedColorScheme = 'light' | 'dark';

/**
 * The storage key for the persisted colour-scheme preference.
 */
export const COLOR_SCHEME_STORAGE_KEY = 'theme';

/**
 * Compose the storage key for a namespaced application.
 *
 * @param namespace - the application namespace, or null for none
 * @returns the namespaced key, or the base key when no namespace
 */
export function composeColorSchemeStorageKey(namespace: string | null, key = COLOR_SCHEME_STORAGE_KEY): string {
    return namespace ? `${namespace}.${key}` : key;
}
