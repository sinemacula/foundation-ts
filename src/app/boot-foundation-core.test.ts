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
import { RuntimeEnvironmentError } from '../config/runtime-environment-error';
import { StaticFeatureFlags } from '../feature-flags/static-feature-flags';
import type { HttpClient, HttpRequest, RequestInterceptor } from '../http/http-client';
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
    /**
     * Reject every call, since the stub must never be used.
     */
    const fail = (): Promise<never> => Promise.reject(new Error('not implemented'));

    return { get: fail, post: fail, put: fail, patch: fail, delete: fail, download: fail };
}

/** A fetch stub resolving an empty runtime document. */
function createFetchStub(): typeof fetch {
    return vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
}

/** A fetch stub plus the urls and inits it captured. */
interface SequencedFetch {
    /** The fetch seam handed to the boot. */
    readonly fetchFn: typeof fetch;

    /** Every requested url, in order. */
    readonly urls: string[];

    /** Every request init, in order. */
    readonly inits: (RequestInit | undefined)[];
}

/**
 * Build a fetch stub that serves the runtime document first, then the given API
 * responses in order.
 *
 * @param apiResponses - response factories for the calls after the runtime
 * fetch
 */
function createSequencedFetch(...apiResponses: ReadonlyArray<() => Response>): SequencedFetch {
    const urls: string[] = [];
    const inits: (RequestInit | undefined)[] = [];

    /** Serve the runtime document, then the queued API responses in order. */
    const fetchFn: typeof fetch = (input, init) => {
        urls.push(String(input));
        inits.push(init);

        if (urls.length === 1) {
            return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
        }

        const factory = apiResponses[urls.length - 2];

        return Promise.resolve(factory === undefined ? new Response('{}', { status: 200 }) : factory());
    };

    return { fetchFn, urls, inits };
}

/** A Toaster that keeps every error message it is asked to raise. */
interface RecordingToaster extends Toaster {
    /** Every error message raised, in order. */
    readonly errors: string[];
}

/** Build a Toaster that records every error message it is asked to raise. */
function createRecordingToaster(): RecordingToaster {
    const errors: string[] = [];

    return {
        errors,
        error: message => {
            errors.push(message);

            return 'id';
        },
        information: () => 'id',
    };
}

/** The runtime environment document location every boot fetches. */
const RUNTIME_URL = '/runtime-env.json';

/** Build an environment that defines no keys. */
const environmentOf = (): Environment => new Environment(new ObjectEnvironmentSource({}));

/** What the registration bridge saw when it ran. */
interface RegistrationObservation {
    /** The configuration handed to the bridge. */
    readonly config: unknown;

    /** Whether storage was already installed. */
    readonly storageOk: boolean;

    /** Whether feature flags were already installed. */
    readonly flagsOk: boolean;
}

/** The http options threaded into the default client. */
interface HttpOptionsUnderTest {
    /** Preset interceptors run before every request. */
    readonly interceptors?: readonly RequestInterceptor[];

    /** Replacement response-error handler. */
    readonly onResponseError?: (error: unknown, request: HttpRequest) => void;

    /** Arms the default handler's toast. */
    readonly unexpectedErrorToastKey?: string;
}

/** One response error routed to the supplied handler. */
interface ResponseFailure {
    /** The error raised. */
    readonly error: unknown;

    /** The request that failed. */
    readonly request: HttpRequest;
}

describe('bootFoundationCore', () => {
    afterEach(() => {
        resetFoundationServices();
    });

    it('installs every core service with the defaults', async () => {
        const storage = new MemoryStorage();
        const toaster = createToasterStub();
        const confirmer = createConfirmerStub();
        const contributions = createContributions();
        const collect = vi.fn().mockReturnValue(contributions);
        const environment = environmentOf();

        const core = await bootFoundationCore(
            {
                createEnvironment: () => environment,
                runtime: { url: RUNTIME_URL },
                define: () => createConfig(),
                storage,
                toasts: toaster,
                confirm: confirmer,
                collectHttpContributions: collect,
            },
            { fetchFn: createFetchStub() },
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
        const runtimeDocument = Object.fromEntries([['API_URL', 'https://runtime.example.com']]);
        const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(runtimeDocument), { status: 200 }));
        const createEnvironment = vi.fn().mockReturnValue(environmentOf());

        await bootFoundationCore(
            {
                createEnvironment,
                runtime: { url: RUNTIME_URL },
                define: () => createConfig(),
                storage: new MemoryStorage(),
                toasts: createToasterStub(),
                confirm: createConfirmerStub(),
                collectHttpContributions: () => createContributions(),
            },
            { fetchFn: fetchFn as unknown as typeof fetch },
        );

        expect(createEnvironment).toHaveBeenCalledWith(runtimeDocument);
    });

    it('skips the fetch and passes empty runtime values without a runtime document', async () => {
        const fetchFn = vi.fn();
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
        );

        expect(fetchFn).not.toHaveBeenCalled();
        expect(createEnvironment).toHaveBeenCalledWith({});
    });

    it('rejects the boot before configuring anything when the runtime document fails', async () => {
        const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
        const createEnvironment = vi.fn();

        const boot = bootFoundationCore(
            {
                runtime: { url: RUNTIME_URL },
                createEnvironment,
                define: () => createConfig(),
                storage: new MemoryStorage(),
                toasts: createToasterStub(),
                confirm: createConfirmerStub(),
                collectHttpContributions: () => createContributions(),
            },
            { fetchFn: fetchFn as unknown as typeof fetch },
        );

        await expect(boot).rejects.toBeInstanceOf(RuntimeEnvironmentError);
        expect(createEnvironment).not.toHaveBeenCalled();
        expect(() => appConfig()).toThrow();
    });

    it('holds the runtime document to the configured timeout', async () => {
        vi.useFakeTimers();

        try {
            const boot = bootFoundationCore(
                {
                    runtime: { url: RUNTIME_URL, timeout: 50 },
                    createEnvironment: () => environmentOf(),
                    define: () => createConfig(),
                    storage: new MemoryStorage(),
                    toasts: createToasterStub(),
                    confirm: createConfirmerStub(),
                    collectHttpContributions: () => createContributions(),
                },
                { fetchFn: () => new Promise<Response>(() => undefined) },
            );
            const settled = boot.catch((error: unknown) => error);

            await vi.advanceTimersByTimeAsync(50);

            await expect(settled).resolves.toStrictEqual(
                new RuntimeEnvironmentError('The runtime environment document did not load within 50 ms.'),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('runs the registration bridge once, after the core installs', async () => {
        const environment = environmentOf();
        const observed: RegistrationObservation[] = [];
        const interceptor = vi.fn();

        const core = await bootFoundationCore(
            {
                createEnvironment: () => environment,
                runtime: { url: RUNTIME_URL },
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
        );

        expect(observed).toHaveLength(1);
        expect(observed[0]?.config).toBe(core.repository);
        expect(observed[0]?.storageOk).toBe(true);
        expect(observed[0]?.flagsOk).toBe(true);
        expect(core.http).toBe(api());
    });

    it('honours every override and reports the core phases in order', async () => {
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
                runtime: { url: RUNTIME_URL },
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

    describe('http option threading into the default client', () => {
        /**
         * Boot the core over a sequenced fetch with the given http options and
         * default collaborators everywhere else.
         */
        function bootWithHttp(
            fetch: SequencedFetch,
            http: HttpOptionsUnderTest,
            toaster: Toaster = createToasterStub(),
        ): ReturnType<typeof bootFoundationCore<FoundationConfig>> {
            return bootFoundationCore(
                {
                    createEnvironment: () => environmentOf(),
                    runtime: { url: RUNTIME_URL },
                    define: () => createConfig(),
                    storage: new MemoryStorage(),
                    toasts: toaster,
                    confirm: createConfirmerStub(),
                    http,
                    collectHttpContributions: () => createContributions(),
                },
                { fetchFn: fetch.fetchFn },
            );
        }

        it('runs the preset interceptors on requests through the built client', async () => {
            /** Stamp a preset header onto the request. */
            const stamp: RequestInterceptor = request => ({
                ...request,
                headers: { ...request.headers, 'x-preset': 'stamped' },
            });
            const fetch = createSequencedFetch();

            const core = await bootWithHttp(fetch, { interceptors: [stamp] });

            await core.http.get('items');

            expect(fetch.urls).toStrictEqual([RUNTIME_URL, 'https://api.example.com/items']);
            expect(fetch.inits[1]?.headers).toMatchObject({ 'x-preset': 'stamped' });
        });

        it('routes response errors to the supplied handler', async () => {
            const failures: ResponseFailure[] = [];
            const fetch = createSequencedFetch(() => new Response('{}', { status: 500 }));

            const core = await bootWithHttp(fetch, {
                onResponseError: (error, request) => {
                    failures.push({ error, request });
                },
            });

            await core.http.get('boom').catch(() => undefined);

            expect(failures).toHaveLength(1);
            expect(failures[0]?.request.url).toBe('https://api.example.com/boom');
        });

        it('arms the default handler with the unexpected-error toast key', async () => {
            const toaster = createRecordingToaster();
            const fetch = createSequencedFetch(() => new Response('{}', { status: 500 }));

            const core = await bootWithHttp(fetch, { unexpectedErrorToastKey: 'app.errors.unexpected' }, toaster);

            await core.http.get('boom').catch(() => undefined);

            expect(toaster.errors).toStrictEqual(['app.errors.unexpected']);
        });
    });
});
