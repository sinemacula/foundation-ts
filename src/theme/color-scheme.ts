/**
 * Colour-scheme types and storage contract.
 *
 * The framework-agnostic surface shared by every platform's colour-scheme
 * service: the preference and resolved types, the persisted storage key, and
 * the namespacing helper. The first-paint boot script is a web concern and
 * lives in foundation-web.
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
 * @param key - the base storage key
 * @returns the namespaced key, or the base key when no namespace
 */
export function composeColorSchemeStorageKey(namespace: string | null, key = COLOR_SCHEME_STORAGE_KEY): string {
    return namespace ? `${namespace}.${key}` : key;
}
