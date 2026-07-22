/**
 * Unit tests for the observability wiring unit.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, describe, expect, it } from 'vitest';

import { ConsoleAnalyticsTracker } from '../analytics/console-analytics-tracker';
import { NullAnalyticsTracker } from '../analytics/null-analytics-tracker';
import { ConsoleLogger } from '../logging/console-logger';
import { NullLogger } from '../logging/null-logger';
import { BreadcrumbTrail } from '../reporting/breadcrumb-trail';
import { ConsoleErrorReporter } from '../reporting/console-error-reporter';
import { NullErrorReporter } from '../reporting/null-error-reporter';
import { analytics, logger, reporting, resetFoundationServices } from './services';
import type { FoundationConfig } from './foundation-config';
import { wireObservability } from './wire-observability';

/**
 * Build a minimal contract-satisfying configuration for the given environment.
 *
 * @param environment - the application environment name
 * @returns the configuration fixture
 */
function createConfig(environment: string): FoundationConfig {
    return {
        api: { baseUrl: 'https://api.example.com', timeout: 30_000 },
        app: { name: 'Test App', environment, version: '1.0.0' },
        featureFlags: { flags: {} },
        locales: {
            default: 'en-US',
            enabled: ['en-US'],
            supported: { 'en-US': { direction: 'ltr' } },
        },
    };
}

describe('wireObservability', () => {
    afterEach(() => {
        resetFoundationServices();
    });

    it('defaults to console adapters in the local environment', () => {
        const result = wireObservability({ config: createConfig('local') });

        expect(result.reporter).toBeInstanceOf(ConsoleErrorReporter);
        expect(result.analytics).toBeInstanceOf(ConsoleAnalyticsTracker);
        expect(result.logger).toBeInstanceOf(ConsoleLogger);
    });

    it('defaults to null adapters outside the local environment', () => {
        const result = wireObservability({ config: createConfig('production') });

        expect(result.reporter).toBeInstanceOf(NullErrorReporter);
        expect(result.analytics).toBeInstanceOf(NullAnalyticsTracker);
        expect(result.logger).toBeInstanceOf(NullLogger);
    });

    it('matches the local environment case-sensitively', () => {
        const result = wireObservability({ config: createConfig('Local') });

        expect(result.reporter).toBeInstanceOf(NullErrorReporter);
        expect(result.analytics).toBeInstanceOf(NullAnalyticsTracker);
        expect(result.logger).toBeInstanceOf(NullLogger);
    });

    it('installs the resolved instances into the service holders', () => {
        const result = wireObservability({ config: createConfig('production') });

        expect(reporting()).toBe(result.reporter);
        expect(analytics()).toBe(result.analytics);
        expect(logger()).toBe(result.logger);
    });

    it('prefers the supplied factories over the environment defaults', () => {
        const customReporter = new NullErrorReporter();
        const customTracker = new NullAnalyticsTracker();
        const customLogger = new NullLogger();

        const result = wireObservability({
            config: createConfig('local'),
            reporter: () => customReporter,
            analytics: () => customTracker,
            logger: () => customLogger,
        });

        expect(result.reporter).toBe(customReporter);
        expect(result.analytics).toBe(customTracker);
        expect(result.logger).toBe(customLogger);
        expect(reporting()).toBe(customReporter);
        expect(analytics()).toBe(customTracker);
        expect(logger()).toBe(customLogger);
    });

    it('keeps environment defaults for factories that are not supplied', () => {
        const customReporter = new NullErrorReporter();

        const result = wireObservability({
            config: createConfig('local'),
            reporter: () => customReporter,
        });

        expect(result.reporter).toBe(customReporter);
        expect(result.analytics).toBeInstanceOf(ConsoleAnalyticsTracker);
        expect(result.logger).toBeInstanceOf(ConsoleLogger);
    });

    it('passes the exact frozen configuration to every factory, once each', () => {
        const config = createConfig('production');
        const received: unknown[] = [];

        wireObservability({
            config,
            reporter: settings => {
                received.push(settings);

                return new NullErrorReporter();
            },
            analytics: settings => {
                received.push(settings);

                return new NullAnalyticsTracker();
            },
            logger: settings => {
                received.push(settings);

                return new NullLogger();
            },
        });

        expect(received).toHaveLength(3);
        expect(received[0]).toBe(config);
        expect(received[1]).toBe(config);
        expect(received[2]).toBe(config);
    });

    it('creates a fresh breadcrumb trail on every call', () => {
        const first = wireObservability({ config: createConfig('production') });
        const second = wireObservability({ config: createConfig('production') });

        expect(first.trail).toBeInstanceOf(BreadcrumbTrail);
        expect(second.trail).toBeInstanceOf(BreadcrumbTrail);
        expect(second.trail).not.toBe(first.trail);
    });
});
