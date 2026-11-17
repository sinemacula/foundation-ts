/**
 * Unit tests for boot-foundation-core.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { NullAnalyticsTracker } from '../analytics/null-analytics-tracker';
import type { ConfigRepository, DeepReadonly } from '../config/config-repository';
import { Environment } from '../config/environment';
import { ObjectEnvironmentSource } from '../config/object-environment-source';
import { RuntimeEnvironmentError } from '../config/runtime-environment-error';
import { StaticFeatureFlags } from '../feature-flags/static-feature-flags';
import type { HttpClient, HttpRequest, RequestInterceptor } from '../http/http-client';
import type { ModuleHttpContributions } from '../http/module-http-contributions';
import { NullLogger } from '../logging/null-logger';
import type { Confirmer } from '../notifications/confirmer';
import type { Toaster } from '../notifications/toaster';
import type { ErrorReporter } from '../reporting/error-reporter';
import { NullErrorReporter } from '../reporting/null-error-reporter';
import { MemoryStorage } from '../storage/memory-storage';
import { SupportError } from '../support/support-error';
import type {
    FoundationCore,
    FoundationCoreOptions,
    FoundationCorePhase,
    FoundationCoreRegistration,
} from './boot-foundation-core';
import { bootFoundationCore } from './boot-foundation-core';
import type { FoundationConfig } from './foundation-config';
import {
    analytics,
    api,
    appConfig,
    appConfigRepository,
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

/** The settings parameter of an optional settings factory. */
type SettingsOf<F> = NonNullable<F> extends (settings: infer S) => unknown ? S : never;

/** The observability factories a boot accepts. */
type ObservabilityOptions<T extends FoundationConfig> = NonNullable<FoundationCoreOptions<T>['observability']>;

/** Every boot surface typed by the application configuration. */
interface CoreTyping<T extends FoundationConfig> {
    /** The frozen settings on the boot result. */
    readonly settings: FoundationCore<T>['settings'];

    /** The repository on the boot result. */
    readonly repository: FoundationCore<T>['repository'];

    /** The repository handed to module registration. */
    readonly registration: FoundationCoreRegistration<T>['config'];

    /** The feature-flag factory's settings parameter. */
    readonly featureFlags: SettingsOf<FoundationCoreOptions<T>['featureFlags']>;

    /** The reporter factory's settings parameter. */
    readonly reporter: SettingsOf<ObservabilityOptions<T>['reporter']>;

    /** The analytics factory's settings parameter. */
    readonly analytics: SettingsOf<ObservabilityOptions<T>['analytics']>;

    /** The logger factory's settings parameter. */
    readonly logger: SettingsOf<ObservabilityOptions<T>['logger']>;

    /** The configuration the HTTP client factory receives. */
    readonly httpClient: Parameters<NonNullable<NonNullable<FoundationCoreOptions<T>['http']>['client']>>[0]['config'];

    /** What booting with the configuration resolves to. */
    readonly boot: ReturnType<typeof bootFoundationCore<T>>;
}

/** The type each boot surface must have for a given configuration. */
interface ExpectedCoreTyping<T extends FoundationConfig> {
    /** Deeply read-only settings. */
    readonly settings: DeepReadonly<T>;

    /** A repository typed by the configuration itself. */
    readonly repository: ConfigRepository<T>;

    /** The same repository type for module registration. */
    readonly registration: ConfigRepository<T>;

    /** Deeply read-only settings for the feature-flag factory. */
    readonly featureFlags: DeepReadonly<T>;

    /** Deeply read-only settings for the reporter factory. */
    readonly reporter: DeepReadonly<T>;

    /** Deeply read-only settings for the analytics factory. */
    readonly analytics: DeepReadonly<T>;

    /** Deeply read-only settings for the logger factory. */
    readonly logger: DeepReadonly<T>;

    /** Deeply read-only settings for the HTTP client factory. */
    readonly httpClient: DeepReadonly<T>;

    /** The core typed by the configuration. */
    readonly boot: Promise<FoundationCore<T>>;
}

/**
 * Return what a call throws, or undefined when it returns.
 */
function errorOf(call: () => unknown): unknown {
    try {
        call();
    } catch (error) {
        return error;
    }

    return undefined;
}

/** The runtime environment document location every boot fetches. */
const RUNTIME_URL = '/runtime-env.json';

/** Build an environment that defines no keys. */
const environmentOf = (): Environment => new Environment(new ObjectEnvironmentSource({}));

/** An application configuration declared as an interface. */
interface InterfaceAppConfig extends FoundationConfig {
    /** Application-specific support settings. */
    readonly support: {
        /** The support contact addresses. */
        readonly emails: string[];
    };
}

/** An application configuration declared as a type alias. */
type AliasAppConfig = FoundationConfig & {
    /** Application-specific support settings. */
    readonly support: {
        /** The support contact addresses. */
        readonly emails: string[];
    };
};

/**
 * Build an interface-declared application configuration fixture.
 */
function createAppConfig(): InterfaceAppConfig {
    return { ...createConfig(), support: { emails: ['support@example.com'] } };
}

/**
 * Build an application configuration that omits the feature flags.
 */
function createConfigWithoutFlags(): Omit<InterfaceAppConfig, 'featureFlags'> {
    const { api: apiSettings, app, locales, support } = createAppConfig();

    return { api: apiSettings, app, locales, support };
}

/**
 * Build every boot option for an interface config except its definition.
 */
function interfaceBootOptions(): Omit<FoundationCoreOptions<InterfaceAppConfig>, 'define'> {
    return {
        createEnvironment: () => environmentOf(),
        storage: new MemoryStorage(),
        toasts: createToasterStub(),
        confirm: createConfirmerStub(),
        collectHttpContributions: () => createContributions(),
    };
}

/** The accessor of every service the core boot installs, by name. */
const CORE_SERVICES = {
    configuration: appConfigRepository,
    storage: appStorage,
    featureFlags,
    toasts,
    confirmDialogs,
    reporting,
    analytics,
    logger,
    api,
} as const;

/** The name of a service the core boot installs. */
type CoreServiceName = keyof typeof CORE_SERVICES;

/** The instance each installed core service resolves to, by name. */
type ResolvedServices = Partial<Record<CoreServiceName, unknown>>;

/**
 * Resolve every installed core service, leaving out those that throw.
 */
function resolveServices(): ResolvedServices {
    return Object.fromEntries(
        Object.entries(CORE_SERVICES).flatMap(([name, accessor]) => {
            try {
                return [[name, accessor()]];
            } catch {
                return [];
            }
        }),
    );
}

/** The collaborators a boot installs exactly as supplied. */
interface BootCollaborators {
    /** The configuration definition, frozen in place by the boot. */
    readonly definition: FoundationConfig;

    /** The storage adapter. */
    readonly storage: MemoryStorage;

    /** The toast notifier. */
    readonly toaster: Toaster;

    /** The confirmation prompter. */
    readonly confirmer: Confirmer;

    /** The feature-flag adapter. */
    readonly flags: StaticFeatureFlags;
}

/**
 * Build a fresh set of boot collaborators.
 */
function createCollaborators(): BootCollaborators {
    return {
        definition: createConfig(),
        storage: new MemoryStorage(),
        toaster: createToasterStub(),
        confirmer: createConfirmerStub(),
        flags: new StaticFeatureFlags({ beta: true }),
    };
}

/**
 * Boot the core over the collaborators without a runtime document, recording
 * each phase before any supplied phase observer runs.
 *
 * @param overrides - options replacing the defaults; `onPhase` runs after the
 * recording
 */
function bootWith(
    collaborators: BootCollaborators,
    overrides: Partial<FoundationCoreOptions<FoundationConfig>> = {},
    phases: FoundationCorePhase[] = [],
): Promise<FoundationCore<FoundationConfig>> {
    const { onPhase, ...rest } = overrides;

    return bootFoundationCore(
        {
            createEnvironment: () => environmentOf(),
            define: () => collaborators.definition,
            storage: collaborators.storage,
            toasts: collaborators.toaster,
            confirm: collaborators.confirmer,
            featureFlags: () => collaborators.flags,
            collectHttpContributions: () => createContributions(),
            ...rest,
            onPhase: phase => {
                phases.push(phase);
                onPhase?.(phase);
            },
        },
        { fetchFn: createFetchStub() },
    );
}

/**
 * Map each core service to the instance a successful boot installed.
 */
function servicesOf(core: FoundationCore<FoundationConfig>, collaborators: BootCollaborators): ResolvedServices {
    return {
        configuration: core.repository,
        storage: collaborators.storage,
        featureFlags: core.flags,
        toasts: collaborators.toaster,
        confirmDialogs: collaborators.confirmer,
        reporting: core.observability.reporter,
        analytics: core.observability.analytics,
        logger: core.observability.logger,
        api: core.http,
    };
}

/**
 * Boot again successfully and assert every core service now resolves to an
 * instance of that boot, none left over from before it.
 */
async function expectCleanReboot(): Promise<void> {
    const before = resolveServices();
    const collaborators = createCollaborators();
    const core = await bootWith(collaborators);
    const after = resolveServices();
    const expected = servicesOf(core, collaborators);

    expect(Object.keys(after)).toStrictEqual(Object.keys(CORE_SERVICES));
    expect(
        Object.keys(expected).filter(name => after[name as CoreServiceName] !== expected[name as CoreServiceName]),
    ).toStrictEqual([]);
    expect(
        Object.entries(before).filter(([name, instance]) => after[name as CoreServiceName] === instance),
    ).toStrictEqual([]);
}

/** What module registration could reach when the bridge ran. */
interface RegistrationObservation {
    /** The phases reported before the bridge ran. */
    readonly phases: readonly FoundationCorePhase[];

    /** The core services resolvable inside the bridge. */
    readonly services: ResolvedServices;

    /** The configuration tree resolvable inside the bridge. */
    readonly config: unknown;

    /** What resolving the http client threw inside the bridge. */
    readonly apiError: unknown;
}

/** One point at which a boot fails, and the state it must leave behind. */
interface BootFailureCase {
    /** Where the failure is raised, for the test title. */
    readonly point: string;

    /** The options that raise the given failure. */
    readonly inject: (failure: Error) => Partial<FoundationCoreOptions<FoundationConfig>>;

    /** The last phase reported before the failure. */
    readonly lastPhase: FoundationCorePhase;

    /** The core services left installed, in declaration order. */
    readonly installed: readonly CoreServiceName[];
}

/** The services installed before the observability phase. */
const BEFORE_OBSERVABILITY: readonly CoreServiceName[] = [
    'configuration',
    'storage',
    'featureFlags',
    'toasts',
    'confirmDialogs',
];

/** The services installed before the HTTP client phase. */
const BEFORE_HTTP: readonly CoreServiceName[] = [...BEFORE_OBSERVABILITY, 'reporting', 'analytics', 'logger'];

/**
 * Build a function that always throws the given failure.
 */
function throwing(failure: Error): () => never {
    return () => {
        throw failure;
    };
}

/**
 * Build an object whose freezing throws the given failure.
 */
function unfreezable(failure: Error): object {
    return new Proxy({}, { preventExtensions: throwing(failure) });
}

const bootFailureCases: readonly BootFailureCase[] = [
    {
        point: 'createEnvironment',
        inject: failure => ({ createEnvironment: throwing(failure) }),
        lastPhase: 'configuration',
        installed: [],
    },
    { point: 'define', inject: failure => ({ define: throwing(failure) }), lastPhase: 'configuration', installed: [] },
    {
        point: 'freezing the definition',
        inject: failure => ({ define: () => Object.assign(createConfig(), { locked: unfreezable(failure) }) }),
        lastPhase: 'configuration',
        installed: [],
    },
    {
        point: 'the phase observer',
        inject: failure => ({
            onPhase: phase => {
                if (phase === 'storage') {
                    throw failure;
                }
            },
        }),
        lastPhase: 'storage',
        installed: ['configuration'],
    },
    {
        point: 'the feature-flag factory',
        inject: failure => ({ featureFlags: throwing(failure) }),
        lastPhase: 'feature-flags',
        installed: ['configuration', 'storage'],
    },
    {
        point: 'the reporter factory',
        inject: failure => ({ observability: { reporter: throwing(failure) } }),
        lastPhase: 'observability',
        installed: BEFORE_OBSERVABILITY,
    },
    {
        point: 'the analytics factory',
        inject: failure => ({ observability: { analytics: throwing(failure) } }),
        lastPhase: 'observability',
        installed: BEFORE_OBSERVABILITY,
    },
    {
        point: 'the logger factory',
        inject: failure => ({ observability: { logger: throwing(failure) } }),
        lastPhase: 'observability',
        installed: BEFORE_OBSERVABILITY,
    },
    {
        point: 'module registration',
        inject: failure => ({ collectHttpContributions: throwing(failure) }),
        lastPhase: 'observability',
        installed: BEFORE_HTTP,
    },
    {
        point: 'the http client factory',
        inject: failure => ({ http: { client: throwing(failure) } }),
        lastPhase: 'http-client',
        installed: BEFORE_HTTP,
    },
];

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

    describe('the default feature flags', () => {
        /**
         * Boot with the default flags over a reporter whose capture is given.
         */
        async function bootFlags(captureError: ErrorReporter['captureError']): Promise<StaticFeatureFlags> {
            const reporter: ErrorReporter = { captureError, captureMessage: vi.fn(), setUser: vi.fn() };
            const core = await bootFoundationCore(
                {
                    createEnvironment: () => environmentOf(),
                    define: () => createConfig(),
                    storage: new MemoryStorage(),
                    toasts: createToasterStub(),
                    confirm: createConfirmerStub(),
                    observability: { reporter: () => reporter },
                    collectHttpContributions: () => createContributions(),
                },
                { fetchFn: createFetchStub() },
            );

            return core.flags as StaticFeatureFlags;
        }

        it('reports a failing change handler to the installed reporter', async () => {
            const failure = new Error('handler failed');
            const captureError = vi.fn();
            const later = vi.fn();
            const flags = await bootFlags(captureError);

            flags.onChange(() => {
                throw failure;
            });
            flags.onChange(later);
            flags.replace({});

            expect(captureError).toHaveBeenCalledExactlyOnceWith(failure, { source: 'feature-flags' });
            expect(later).toHaveBeenCalledOnce();
        });

        it.each([
            [
                'a throwing reporter',
                (): void => {
                    throw new Error('reporter failed');
                },
                false,
            ],
            ['no installed reporter', vi.fn(), true],
        ])('contains %s and runs the remaining handlers', async (_case, captureError, reset) => {
            const later = vi.fn();
            const flags = await bootFlags(captureError);

            if (reset) {
                resetFoundationServices();
            }

            flags.onChange(() => {
                throw new Error('handler failed');
            });
            flags.onChange(later);

            expect(() => {
                flags.replace({});
            }).not.toThrow();
            expect(later).toHaveBeenCalledOnce();
        });
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

    it('runs the registration bridge once, after every core service but the http client installs', async () => {
        const collaborators = createCollaborators();
        const phases: FoundationCorePhase[] = [];
        const registrations: FoundationCoreRegistration<FoundationConfig>[] = [];
        const seen: RegistrationObservation[] = [];

        const core = await bootWith(
            collaborators,
            {
                collectHttpContributions: registration => {
                    registrations.push(registration);
                    seen.push({
                        phases: [...phases],
                        services: resolveServices(),
                        config: appConfig(),
                        apiError: errorOf(api),
                    });

                    return createContributions();
                },
            },
            phases,
        );

        const expected = servicesOf(core, collaborators);

        expect(registrations).toHaveLength(1);
        expect(registrations[0]?.config).toBe(core.repository);
        expect(registrations[0]?.environment).toBe(core.environment);
        expect(seen[0]?.phases.at(-1)).toBe('observability');
        expect(seen[0]?.config).toBe(core.settings);
        expect(Object.keys(seen[0]?.services ?? {})).toStrictEqual(BEFORE_HTTP);
        expect(BEFORE_HTTP.filter(name => seen[0]?.services[name] !== expected[name])).toStrictEqual([]);
        expect(seen[0]?.apiError).toStrictEqual(new SupportError('http client accessed before initialisation'));
        expect(api()).toBe(core.http);
    });

    it('freezes the whole settings tree it hands out', async () => {
        const core = await bootWith(createCollaborators());

        expect(Object.isFrozen(core.settings.api)).toBe(true);
        expect(Object.isFrozen(core.settings.locales.enabled)).toBe(true);
        expect(Object.isFrozen(core.settings.featureFlags.flags)).toBe(true);
    });

    it.each(bootFailureCases)(
        'rejects with the original error when $point throws, keeps what it installed, and reboots cleanly',
        async ({ inject, lastPhase, installed }) => {
            const failure = new Error('boot step failed');
            const phases: FoundationCorePhase[] = [];

            await expect(bootWith(createCollaborators(), inject(failure), phases)).rejects.toBe(failure);

            expect(phases.at(-1)).toBe(lastPhase);
            expect(Object.keys(resolveServices())).toStrictEqual(installed);

            await expectCleanReboot();
        },
    );

    it('keeps the services of an earlier boot that a failed boot had not yet replaced', async () => {
        const first = createCollaborators();
        const core = await bootWith(first);
        const second = createCollaborators();
        const failure = new Error('reporter unavailable');

        await expect(bootWith(second, { observability: { reporter: throwing(failure) } })).rejects.toBe(failure);

        expect(appConfigRepository().all()).toBe(second.definition);
        expect(appStorage()).toBe(second.storage);
        expect(featureFlags()).toBe(second.flags);
        expect(toasts()).toBe(second.toaster);
        expect(confirmDialogs()).toBe(second.confirmer);
        expect(reporting()).toBe(core.observability.reporter);
        expect(analytics()).toBe(core.observability.analytics);
        expect(logger()).toBe(core.observability.logger);
        expect(api()).toBe(core.http);
    });

    describe('typing', () => {
        it('types every configuration-shaped surface for interface and alias configs', () => {
            expectTypeOf<CoreTyping<InterfaceAppConfig>>().toEqualTypeOf<ExpectedCoreTyping<InterfaceAppConfig>>();
            expectTypeOf<CoreTyping<AliasAppConfig>>().toEqualTypeOf<ExpectedCoreTyping<AliasAppConfig>>();
            expectTypeOf<FoundationCore<InterfaceAppConfig>['settings']['support']['emails']>().toEqualTypeOf<
                readonly string[]
            >();
        });

        it('rejects a definition without the feature flags at compile time', () => {
            expectTypeOf(() =>
                bootFoundationCore<InterfaceAppConfig>(
                    {
                        ...interfaceBootOptions(),
                        // @ts-expect-error the definition must carry the feature flags
                        define: () => createConfigWithoutFlags(),
                    },
                    { fetchFn: createFetchStub() },
                ),
            ).toBeFunction();
        });

        it('boots an interface config and hands the factories its frozen settings', async () => {
            const received: DeepReadonly<InterfaceAppConfig>[] = [];

            const core = await bootFoundationCore<InterfaceAppConfig>(
                {
                    ...interfaceBootOptions(),
                    define: () => createAppConfig(),
                    featureFlags: settings => {
                        received.push(settings);

                        return new StaticFeatureFlags(settings.featureFlags.flags);
                    },
                },
                { fetchFn: createFetchStub() },
            );

            expect(received).toHaveLength(1);
            expect(received[0]).toBe(core.settings);
            expect(core.settings.support.emails).toStrictEqual(['support@example.com']);
            expect(Object.isFrozen(core.settings.support.emails)).toBe(true);
        });

        it('hands the HTTP client factory the frozen settings, nested arrays read-only', async () => {
            const received: DeepReadonly<InterfaceAppConfig>[] = [];

            const core = await bootFoundationCore<InterfaceAppConfig>(
                {
                    ...interfaceBootOptions(),
                    define: () => createAppConfig(),
                    http: {
                        client: tools => {
                            received.push(tools.config);

                            expectTypeOf(() => {
                                // @ts-expect-error the nested configuration is read-only
                                tools.config.support.emails.push('other@example.com');
                            }).toBeFunction();

                            return createHttpClientStub();
                        },
                    },
                },
                { fetchFn: createFetchStub() },
            );

            expect(received).toStrictEqual([core.settings]);
            expect(received[0]).toBe(core.settings);
        });
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
