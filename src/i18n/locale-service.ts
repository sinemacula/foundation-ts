/**
 * Locale detection and persistence.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { KeyValueStorage } from '../storage/key-value-storage';

const DEFAULT_STORAGE_KEY = 'locale';

const SCRIPT_SUBTAG = /^[a-z]{4}$/;

const REGION_SUBTAG = /^(?:[a-z]{2}|\d{3})$/;

/**
 * The language, script and region subtags of a normalised locale tag.
 */
interface LanguageTag {
    /** The primary language subtag. */
    readonly language: string;

    /** The script subtag, when present. */
    readonly script: string | undefined;

    /** The region subtag, when present. */
    readonly region: string | undefined;
}

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
     * Resolve the active locale: the stored preference, then the first matching
     * candidate, then the default.
     *
     * @param candidates - preferred locales, most preferred first (typically
     * `navigator.languages`)
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
     * Match a candidate against the enabled locales, ignoring case and reading
     * `_` as `-`: an exact match first, then the best locale of the same
     * language, ranked by script and then region. For each, a matching subtag
     * beats one the enabled locale leaves out, which beats any other; ties go
     * to list order. Variants, extensions and private-use subtags are ignored,
     * and no likely subtags are inferred, so `zh-HK` does not imply `Hant`.
     *
     * @returns the matching enabled locale, or null when none matches
     */
    match(candidate: string): string | null {
        const normalised = normalise(candidate);
        const exact = this.#enabledLocales.find(locale => normalise(locale) === normalised);

        if (exact !== undefined) {
            return exact;
        }

        const wanted = parseTag(normalised);
        let best: string | null = null;
        let bestScore = -1;

        for (const locale of this.#enabledLocales) {
            const offered = parseTag(normalise(locale));

            if (offered.language !== wanted.language) {
                continue;
            }

            const score = subtagRank(wanted.script, offered.script) * 3 + subtagRank(wanted.region, offered.region);

            if (score > bestScore) {
                best = locale;
                bestScore = score;
            }
        }

        return best;
    }

    /**
     * Persist the user's locale choice.
     */
    persist(locale: string): void {
        this.#storage.set(this.#storageKey, locale);
    }
}

/**
 * Lower-case a locale tag and read `_` separators as `-`.
 */
function normalise(locale: string): string {
    return locale.toLowerCase().replaceAll('_', '-');
}

/**
 * Split a normalised tag into its language, script and region, ignoring
 * everything from the first singleton subtag on.
 */
function parseTag(tag: string): LanguageTag {
    const separator = tag.indexOf('-');

    if (separator === -1) {
        return { language: tag, script: undefined, region: undefined };
    }

    const subtags = tag.slice(separator + 1).split('-');
    const singleton = subtags.findIndex(subtag => subtag.length === 1);
    const core = singleton === -1 ? subtags : subtags.slice(0, singleton);

    return {
        language: tag.slice(0, separator),
        script: core.find(subtag => SCRIPT_SUBTAG.test(subtag)),
        region: core.find(subtag => REGION_SUBTAG.test(subtag)),
    };
}

/**
 * Rank how well an enabled locale's subtag serves the wanted one: 2 for a
 * match, 1 when the enabled locale leaves it out, 0 otherwise.
 */
function subtagRank(wanted: string | undefined, offered: string | undefined): number {
    if (wanted === offered) {
        return 2;
    }

    return offered === undefined ? 1 : 0;
}
