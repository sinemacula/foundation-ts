/**
 * Unit tests for the preset configuration contract.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import type { FoundationConfig } from './foundation-config';

/**
 * Build a configuration tree mirroring the reference application's
 * `defineConfiguration` output shape, extra keys included, so assignment to
 * {@link FoundationConfig} pins structural satisfaction at compile time.
 *
 * @returns a configuration tree richer than the contract slice
 */
function definePlaygroundShapedConfiguration() {
    return {
        api: { baseUrl: 'https://api.example.com', timeout: 30_000 },
        app: {
            environment: 'production',
            name: 'Web Core',
            version: '1.2.3',
            urls: {
                api: 'https://api.example.com',
                app: 'https://app.example.com',
                static: 'https://app.example.com',
                stream: 'https://api.example.com',
            },
            links: {
                terms: 'https://www.example.com/terms',
                privacy: 'https://www.example.com/privacy',
            },
        },
        featureFlags: { flags: { beta: true, theme: 'dark', limit: 10 } },
        locales: {
            default: 'en-US',
            enabled: ['en-US', 'fr-FR'],
            supported: {
                'en-US': { name: 'English', direction: 'ltr' as const },
                'ar-SA': { name: 'Arabic', direction: 'rtl' as const },
            },
        },
        services: { sentry: { dsn: '' } },
    };
}

describe('FoundationConfig', () => {
    it('is satisfied structurally by a playground-shaped configuration tree', () => {
        const configuration: FoundationConfig = definePlaygroundShapedConfiguration();

        expect(configuration.api.baseUrl).toBe('https://api.example.com');
        expect(configuration.api.timeout).toBe(30_000);
        expect(configuration.app.name).toBe('Web Core');
        expect(configuration.app.environment).toBe('production');
        expect(configuration.app.version).toBe('1.2.3');
        expect(configuration.featureFlags.flags).toEqual({ beta: true, theme: 'dark', limit: 10 });
        expect(configuration.locales.default).toBe('en-US');
        expect(configuration.locales.enabled).toEqual(['en-US', 'fr-FR']);
        expect(configuration.locales.supported['en-US']?.direction).toBe('ltr');
        expect(configuration.locales.supported['ar-SA']?.direction).toBe('rtl');
    });
});
