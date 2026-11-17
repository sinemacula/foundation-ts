/**
 * Unit tests for locale-service.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../storage/memory-storage';
import { LocaleService } from './locale-service';

/** Options shaping the service under test. */
interface ServiceOptions {
    /** The locale used when nothing else matches. */
    readonly defaultLocale?: string;

    /** The locales the service may resolve to. */
    readonly enabledLocales?: readonly string[];

    /** The storage key the locale is persisted under. */
    readonly storageKey?: string;

    /** A locale already persisted before the service starts. */
    readonly initialStored?: string;
}

/** The service under test and the storage backing it. */
interface ServiceFixture {
    /** The locale service. */
    readonly service: LocaleService;

    /** The storage the service persists to. */
    readonly storage: MemoryStorage;
}

/**
 * Build a locale service over in-memory storage.
 */
function makeService(options?: ServiceOptions): ServiceFixture {
    const storage = new MemoryStorage();

    if (options?.initialStored !== undefined) {
        storage.set(options.storageKey ?? 'locale', options.initialStored);
    }

    const service = new LocaleService({
        defaultLocale: options?.defaultLocale ?? 'en-GB',
        enabledLocales: options?.enabledLocales ?? ['en-GB', 'fr-FR'],
        storage,
        ...(options?.storageKey !== undefined ? { storageKey: options.storageKey } : {}),
    });

    return { service, storage };
}

describe('LocaleService', () => {
    describe('detect', () => {
        it('prefers the stored locale, case-insensitively', () => {
            const { service } = makeService({ initialStored: 'en-gb', enabledLocales: ['en-GB', 'fr-FR'] });

            expect(service.detect(['fr-FR'])).toBe('en-GB');
        });

        it('prefers an exact region match over an earlier same-language locale', () => {
            const { service } = makeService({ initialStored: 'en-gb', enabledLocales: ['en-US', 'en-GB'] });

            expect(service.detect([])).toBe('en-GB');
        });

        it('falls through to candidates when the stored locale matches nothing', () => {
            const { service } = makeService({
                enabledLocales: ['en-GB', 'fr-FR'],
                initialStored: 'de-DE',
            });

            expect(service.detect(['fr-FR'])).toBe('fr-FR');
        });

        it('returns the default when no candidate matches', () => {
            const { service } = makeService({ defaultLocale: 'en-GB', enabledLocales: ['en-GB'] });

            expect(service.detect(['de-DE'])).toBe('en-GB');
        });

        it('returns the default when there are no candidates', () => {
            const { service } = makeService();

            expect(service.detect([])).toBe('en-GB');
        });

        it('defaults to no candidates', () => {
            const { service } = makeService({ defaultLocale: 'en-GB', enabledLocales: ['en-GB'] });

            expect(service.detect()).toBe('en-GB');
        });

        it('returns the first matching candidate', () => {
            const { service } = makeService({ enabledLocales: ['en-GB', 'fr-FR'] });

            expect(service.detect(['fr-FR', 'en-GB'])).toBe('fr-FR');
        });

        it('reads a custom storage key', () => {
            const { service } = makeService({
                storageKey: 'app_locale',
                initialStored: 'fr-FR',
                enabledLocales: ['en-GB', 'fr-FR'],
            });

            expect(service.detect([])).toBe('fr-FR');
        });

        it('reads the default storage key', () => {
            const { service } = makeService({ initialStored: 'fr-FR' });

            expect(service.detect([])).toBe('fr-FR');
        });

        it('matches a stored underscore locale', () => {
            const { service } = makeService({ initialStored: 'en_GB', enabledLocales: ['en-US', 'en-GB'] });

            expect(service.detect([])).toBe('en-GB');
        });
    });

    describe('match', () => {
        it('matches an exact locale case-insensitively', () => {
            const { service } = makeService({ enabledLocales: ['en-GB', 'fr-FR'] });

            expect(service.match('EN-GB')).toBe('en-GB');
        });

        it('falls back to a language match (fr-CA -> fr-FR)', () => {
            const { service } = makeService({ enabledLocales: ['en-GB', 'fr-FR'] });

            expect(service.match('fr-CA')).toBe('fr-FR');
        });

        it('returns null when nothing matches', () => {
            const { service } = makeService({ enabledLocales: ['en-GB', 'fr-FR'] });

            expect(service.match('de-DE')).toBeNull();
        });

        it('returns null for an unmatched multi-subtag candidate', () => {
            const { service } = makeService({ enabledLocales: ['en-GB'] });

            expect(service.match('zh-Hans-CN')).toBeNull();
        });

        it('matches a bare language to a regional locale (fr -> fr-FR)', () => {
            const { service } = makeService({ enabledLocales: ['en-GB', 'fr-FR'] });

            expect(service.match('fr')).toBe('fr-FR');
        });

        it('matches a regional candidate to a bare language (fr-CA -> fr)', () => {
            const { service } = makeService({ enabledLocales: ['en-GB', 'fr'] });

            expect(service.match('fr-CA')).toBe('fr');
        });

        const chinese = ['zh-CN', 'zh-TW', 'sr-Cyrl', 'sr-Latn'];

        it.each([
            [['en-GB', 'fr-FR'], 'fr_FR', 'fr-FR'],
            [['en-US', 'en-GB'], 'EN_gb', 'en-GB'],
            [chinese, 'zh-Hant-TW', 'zh-TW'],
            [chinese, 'zh_TW', 'zh-TW'],
            [chinese, 'sr-Latn-RS', 'sr-Latn'],
            [['zh-Hans-CN', 'zh-Hant-TW'], 'zh-Hant-CN', 'zh-Hant-TW'],
            [['zh-Hans', 'zh'], 'zh-Hant', 'zh'],
            [['fr-FR', 'fr'], 'fr-CA', 'fr'],
            [['en-US', 'en'], 'en-x-us', 'en'],
            [['en-x-us', 'en'], 'en-x-us', 'en-x-us'],
            [['es-419', 'es-ES'], 'es-419', 'es-419'],
            [['de-DE', 'de-CH'], 'de-CH-1996', 'de-CH'],
            [['de-DE', 'de-CH'], 'de-1996-CH', 'de-CH'],
            [['ca-ES', 'ca-AD'], 'ca-valencia-AD', 'ca-AD'],
            [['sl-IT', 'sl-rozaj'], 'sl-rozaj-IT', 'sl-IT'],
            [['es', 'es-419'], 'es-Latn-419', 'es-419'],
        ])('matches regardless of list order: %j with %s -> %s', (enabledLocales, candidate, expected) => {
            expect(makeService({ enabledLocales }).service.match(candidate)).toBe(expected);
            expect(makeService({ enabledLocales: [...enabledLocales].reverse() }).service.match(candidate)).toBe(
                expected,
            );
        });

        it.each([
            [chinese, 'sr', 'sr-Cyrl'],
            [chinese, 'zh-HK', 'zh-CN'],
            [['zh-TW', 'zh-CN'], 'zh-HK', 'zh-TW'],
        ])('breaks an equal-rank tie by list order: %j with %s -> %s', (enabledLocales, candidate, expected) => {
            expect(makeService({ enabledLocales }).service.match(candidate)).toBe(expected);
        });

        it.each([
            ['sr-Latn', 'sr-Cyrl'],
            ['sr-Latn-ME', 'sr-Cyrl-RS'],
        ])('falls back from %s to the same language in a conflicting script (%s)', (candidate, enabled) => {
            expect(makeService({ enabledLocales: [enabled] }).service.match(candidate)).toBe(enabled);
        });

        it('returns null for a language that is not enabled', () => {
            expect(makeService({ enabledLocales: chinese }).service.match('de')).toBeNull();
        });
    });

    describe('persist', () => {
        it('writes under the default key', () => {
            const { service, storage } = makeService();

            service.persist('fr-FR');

            expect(storage.get('locale')).toBe('fr-FR');
        });

        it('writes under a custom key', () => {
            const { service, storage } = makeService({ storageKey: 'my_locale' });

            service.persist('en-GB');

            expect(storage.get('my_locale')).toBe('en-GB');
        });
    });
});
