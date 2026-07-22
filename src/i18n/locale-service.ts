/**
 * Locale detection and persistence.
 *
 * Resolution order: a stored preference wins, then the caller-provided
 * candidates (typically `navigator.languages`), then the configured default.
 * Matching is case-insensitive and falls back from exact region matches
 * (`fr-CA`) to language matches (`fr-FR`).
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { KeyValueStorage } from '../storage/key-value-storage';

const DEFAULT_STORAGE_KEY = 'locale';

/**
 * Construction options for {@link LocaleService}.
 */
export interface LocaleServiceOptions {
    /** The locale used when nothing else matches. */
    readonly defaultLocale: string;

    /** The locales a candidate may resolve to. */
    readonly enabledLocales: readonly string[];

    /** Backing store for the persisted locale preference. */
    readonly storage: KeyValueStorage;

    /** The storage key for the persisted preference. Defaults to `locale`. */
    readonly storageKey?: string;
}

/**
 * Detects, matches and persists the active locale.
 */
export class LocaleService {
    /** The locale used when nothing else matches. */
    readonly #defaultLocale: string;

    /** The locales a candidate may resolve to. */
    readonly #enabledLocales: readonly string[];

    /** Backing store for the persisted locale preference. */
    readonly #storage: KeyValueStorage;

    /** The resolved storage key for the persisted preference. */
    readonly #storageKey: string;

    constructor(options: LocaleServiceOptions) {
        this.#defaultLocale = options.defaultLocale;
        this.#enabledLocales = options.enabledLocales;
        this.#storage = options.storage;
        this.#storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    }

    /**
     * Resolve the active locale.
     *
     * @param candidates - preferred locales, most preferred first
     * @returns the first enabled match, or the default locale
     */
    detect(candidates: readonly string[] = []): string {
        const stored = this.#storage.get(this.#storageKey);
        const storedMatch = stored === null ? null : this.match(stored);

        if (storedMatch !== null) {
            return storedMatch;
        }

        for (const candidate of candidates) {
            const candidateMatch = this.match(candidate);

            if (candidateMatch !== null) {
                return candidateMatch;
            }
        }

        return this.#defaultLocale;
    }

    /**
     * Match a candidate against the enabled locales.
     *
     * @param candidate - the locale code to match (e.g. `fr-CA`)
     * @returns the enabled locale it resolves to, or null
     */
    match(candidate: string): string | null {
        const normalised = candidate.toLowerCase();

        for (const locale of this.#enabledLocales) {
            if (locale.toLowerCase() === normalised) {
                return locale;
            }
        }

        const language = languageOf(normalised);

        for (const locale of this.#enabledLocales) {
            if (languageOf(locale.toLowerCase()) === language) {
                return locale;
            }
        }

        return null;
    }

    /**
     * Persist the user's locale choice.
     *
     * @param locale - the locale code to store
     */
    persist(locale: string): void {
        this.#storage.set(this.#storageKey, locale);
    }
}

/**
 * Extract the language subtag from a normalised locale code.
 *
 * @param locale - the lower-cased locale code (e.g. `fr-ca`)
 * @returns the language subtag (e.g. `fr`)
 */
function languageOf(locale: string): string {
    const separatorIndex = locale.indexOf('-');

    return separatorIndex === -1 ? locale : locale.slice(0, separatorIndex);
}
