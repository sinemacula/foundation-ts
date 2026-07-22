/**
 * Unit tests for boot-foundation-core.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NullAnalyticsTracker } from '../analytics/null-analytics-tracker';
import { Environment } from '../config/environment';
import { ObjectEnvironmentSource } from '../config/object-environment-source';
import { StaticFeatureFlags } from '../feature-flags/static-feature-flags';
import type { HttpClient } from '../http/http-client';
import type { ModuleHttpContributions } from '../http/module-http-contributions';
import { NullLogger } from '../logging/null-logger';
import type { Confirmer } from '../notifications/confirmer';
import type { Toaster } from '../notifications/toaster';
import { NullErrorReporter } from '../reporting/null-error-reporter';
import { MemoryStorage } from '../storage/memory-storage';
import type { FoundationCorePhase } from './boot-foundation-core';
import { bootFoundationCore } from './boot-foundation-core';
import type { FoundationConfig } from './foundation-config';
import {
    analytics,
    api,
    appConfig,
    appStorage,
    confirmDialogs,
    featureFlags,
    logger,
    reporting,
    resetFoundationServices,
    toasts,
} from './services';

/**
 * Build a minimal contract-satisfying configuration fixture.
 *
 * @returns the configuration fixture
 */
function createConfig(): FoundationConfig {
    return {
        api: { baseUrl: 'https://api.example.com', timeout: 30_000 },
        app: { name: 'Test App', environment: 'production', version: '1.0.0' },
        featureFlags: { flags: { beta: true } },
        locales: {
            default: 'en-US',
            enabled: ['en-US'],
            supported: { 'en-US': { direction: 'ltr' } },
        },
    };
}

/**
 * Build empty module HTTP contributions with optional overrides.
 *
 * @param overrides - fields to replace on the empty contribution set
 * @returns the contributions fixture
 */
function createContributions(overrides: Partial<ModuleHttpContributions> = {}): ModuleHttpContributions {
    return { requestInterceptors: [], onUnauthorized: null, responseErrorHandlers: [], ...overrides };
}

/** Build an inert Toaster stand-in. */
function createToasterStub(): Toaster {
    return { error: () => 'id', information: () => 'id' };
}

/** Build an inert Confirmer stand-in. */
function createConfirmerStub(): Confirmer {
    return { confirm: () => Promise.resolve(true) };
}

/** Build an HTTP client stand-in that fails loudly if any method is invoked. */
function createHttpClientStub(): HttpClient {
    const fail = (): Promise<never> => Promise.reject(new Error('not implemented'));

    return { get: fail, post: fail, put: fail, patch: fail, delete: fail, download: fail };
}

/** A fetch stub resolving an empty runtime document. */
function createFetchStub(): typeof fetch {
    return vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
}

const environmentOf = (): Environment => new Environment(new ObjectEnvironmentSource({}));

describe('bootFoundationCore', () => {
    afterEach(() => {
        resetFoundationServices();
    });

    it('boots with defaults, installs every core service, and returns the core', async () => {
        const storage = new MemoryStorage();
        const toaster = createToasterStub();
        const confirmer = createConfirmerStub();
        const contributions = createContributions();
        const collect = vi.fn().mockReturnValue(contributions);
        const environment = environmentOf();

        const core = await bootFoundationCore(
            {
                createEnvironment: () => environment,
                define: () => createConfig(),
                storage,
                toasts: toaster,
                confirm: confirmer,
                collectHttpContributions: collect,
            },
            { fetchFn: createFetchStub() },
            '/runtime-env.json',
        );

        expect(core.environment).toBe(environment);
        expect(core.settings.app.name).toBe('Test App');
        expect(core.repository.all()).toBe(core.settings);
        expect(core.flags).toBeInstanceOf(StaticFeatureFlags);
        expect(core.flags.isEnabled('beta')).toBe(true);

        expect(appConfig()).toBe(core.settings);
        expect(appStorage()).toBe(storage);
        expect(toasts()).toBe(toaster);
        expect(confirmDialogs()).toBe(confirmer);
        expect(featureFlags()).toBe(core.flags);
        expect(reporting()).toBe(core.observability.reporter);
        expect(analytics()).toBe(core.observability.analytics);
        expect(logger()).toBe(core.observability.logger);
        expect(api()).toBe(core.http);
    });

    it('passes the fetched runtime document into createEnvironment', async () => {
        const fetchFn = vi
            .fn()
            .mockResolvedValue(new Response(JSON.stringify({ API_URL: 'https://runtime.example.com' }), { status: 200 }));
        const createEnvironment = vi.fn().mockReturnValue(environmentOf());

        await bootFoundationCore(
            {
                createEnvironment,
                define: () => createConfig(),
                storage: new MemoryStorage(),
                toasts: createToasterStub(),
                confirm: createConfirmerStub(),
                collectHttpContributions: () => createContributions(),
            },
            { fetchFn: fetchFn as unknown as typeof fetch },
            '/runtime-env.json',
        );

        expect(createEnvironment).toHaveBeenCalledWith({ API_URL: 'https://runtime.example.com' });
    });

    it('invokes the registration bridge once, after installs, with the repository and environment', async () => {
        const environment = environmentOf();
        const observed: { config: unknown; storageOk: boolean; flagsOk: boolean }[] = [];
        const interceptor = vi.fn();

        const core = await bootFoundationCore(
            {
                createEnvironment: () => environment,
                define: () => createConfig(),
                storage: new MemoryStorage(),
                toasts: createToasterStub(),
                confirm: createConfirmerStub(),
                collectHttpContributions: registration => {
                    observed.push({
                        config: registration.config,
                        storageOk: appStorage() !== null,
                        flagsOk: featureFlags().isEnabled('beta'),
                    });

                    return createContributions({ requestInterceptors: [interceptor] });
                },
            },
            { fetchFn: createFetchStub() },
            '/runtime-env.json',
        );

        expect(observed).toHaveLength(1);
        expect(observed[0]?.config).toBe(core.repository);
        expect(observed[0]?.storageOk).toBe(true);
        expect(observed[0]?.flagsOk).toBe(true);
        expect(core.http).toBe(api());
    });

    it('boots with every override and records exactly the seven core phases in order', async () => {
        const phases: FoundationCorePhase[] = [];
        const flags = new StaticFeatureFlags({ custom: true });
        const reporter = new NullErrorReporter();
        const tracker = new NullAnalyticsTracker();
        const log = new NullLogger();
        const client = createHttpClientStub();
        const interceptor = vi.fn();
        const onResponseError = vi.fn();

        const core = await bootFoundationCore(
            {
                createEnvironment: () => environmentOf(),
                define: () => createConfig(),
                storage: new MemoryStorage(),
                toasts: createToasterStub(),
                confirm: createConfirmerStub(),
                featureFlags: () => flags,
                observability: {
                    reporter: () => reporter,
                    analytics: () => tracker,
                    logger: () => log,
                },
                http: {
                    interceptors: [interceptor],
                    onResponseError,
                    unexpectedErrorToastKey: 'app.errors.unexpected',
                    client: () => client,
                },
                collectHttpContributions: () => createContributions(),
                onPhase: phase => {
                    phases.push(phase);
                },
            },
            { fetchFn: createFetchStub() },
            '/runtime-env.json',
        );

        expect(phases).toStrictEqual([
            'runtime-environment',
            'configuration',
            'storage',
            'feature-flags',
            'notifications',
            'observability',
            'http-client',
        ]);
        expect(core.flags).toBe(flags);
        expect(core.observability.reporter).toBe(reporter);
        expect(core.observability.analytics).toBe(tracker);
        expect(core.observability.logger).toBe(log);
        expect(core.http).toBe(client);
    });
});
