/**
 * Unit tests for locale-service.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../storage/memory-storage';
import { LocaleService } from './locale-service';

function makeService(options?: {
    defaultLocale?: string;
    enabledLocales?: readonly string[];
    storageKey?: string;
    initialStored?: string;
}): { service: LocaleService; storage: MemoryStorage } {
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
        it('returns the stored locale when it matches exactly (case-insensitive)', () => {
            const { service } = makeService({ initialStored: 'en-gb', enabledLocales: ['en-GB', 'fr-FR'] });

            expect(service.detect(['fr-FR'])).toBe('en-GB');
        });

        it('falls through to candidates when the stored value matches nothing', () => {
            const { service } = makeService({
                enabledLocales: ['en-GB', 'fr-FR'],
                initialStored: 'de-DE',
            });

            expect(service.detect(['fr-FR'])).toBe('fr-FR');
        });

        it('returns the default locale when no stored value and no matching candidates', () => {
            const { service } = makeService({ defaultLocale: 'en-GB', enabledLocales: ['en-GB'] });

            expect(service.detect(['de-DE'])).toBe('en-GB');
        });

        it('returns the default locale when no stored value and candidates is empty', () => {
            const { service } = makeService();

            expect(service.detect([])).toBe('en-GB');
        });

        it('uses default empty candidates when called with no arguments', () => {
            const { service } = makeService({ defaultLocale: 'en-GB', enabledLocales: ['en-GB'] });

            expect(service.detect()).toBe('en-GB');
        });

        it('returns the first matching candidate when no stored value', () => {
            const { service } = makeService({ enabledLocales: ['en-GB', 'fr-FR'] });

            expect(service.detect(['fr-FR', 'en-GB'])).toBe('fr-FR');
        });

        it('uses the custom storageKey when specified', () => {
            const { service } = makeService({
                storageKey: 'app_locale',
                initialStored: 'fr-FR',
                enabledLocales: ['en-GB', 'fr-FR'],
            });

            expect(service.detect([])).toBe('fr-FR');
        });

        it('uses the default storageKey when no storageKey is provided', () => {
            const storage = new MemoryStorage();

            storage.set('locale', 'fr-FR');

            const service = new LocaleService({
                defaultLocale: 'en-GB',
                enabledLocales: ['en-GB', 'fr-FR'],
                storage,
            });

            expect(service.detect([])).toBe('fr-FR');
        });
    });

    describe('match', () => {
        it('matches an exact locale (case-insensitive)', () => {
            const { service } = makeService({ enabledLocales: ['en-GB', 'fr-FR'] });

            expect(service.match('EN-GB')).toBe('en-GB');
        });

        it('matches by language prefix when no exact match (fr-CA → fr-FR)', () => {
            const { service } = makeService({ enabledLocales: ['en-GB', 'fr-FR'] });

            expect(service.match('fr-CA')).toBe('fr-FR');
        });

        it('returns null when no exact or prefix match exists', () => {
            const { service } = makeService({ enabledLocales: ['en-GB', 'fr-FR'] });

            expect(service.match('de-DE')).toBeNull();
        });

        it('returns null when candidate matches no language prefix', () => {
            const { service } = makeService({ enabledLocales: ['en-GB'] });

            expect(service.match('zh-Hans-CN')).toBeNull();
        });

        it('matches a bare language candidate against a regional locale (fr → fr-FR)', () => {
            const { service } = makeService({ enabledLocales: ['en-GB', 'fr-FR'] });

            expect(service.match('fr')).toBe('fr-FR');
        });

        it('matches a regional candidate against a bare enabled language (fr-CA → fr)', () => {
            const { service } = makeService({ enabledLocales: ['en-GB', 'fr'] });

            expect(service.match('fr-CA')).toBe('fr');
        });
    });

    describe('persist', () => {
        it('writes the locale to storage under the default key', () => {
            const { service, storage } = makeService();

            service.persist('fr-FR');

            expect(storage.get('locale')).toBe('fr-FR');
        });

        it('writes the locale to storage under a custom key', () => {
            const { service, storage } = makeService({ storageKey: 'my_locale' });

            service.persist('en-GB');

            expect(storage.get('my_locale')).toBe('en-GB');
        });
    });
});
