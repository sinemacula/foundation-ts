/**
 * Platform-agnostic boot phases that each kernel wraps with its own.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { AnalyticsTracker } from '../analytics/analytics-tracker';
import { ConfigRepository } from '../config/config-repository';
import type { Environment } from '../config/environment';
import type { RuntimeEnvironmentSource } from '../config/runtime-environment';
import { fetchRuntimeEnvironment } from '../config/runtime-environment';
import type { FeatureFlags } from '../feature-flags/feature-flags';
import { StaticFeatureFlags } from '../feature-flags/static-feature-flags';
import type { HttpClient, RequestInterceptor, ResponseErrorHandler } from '../http/http-client';
import type { ModuleHttpContributions } from '../http/module-http-contributions';
import type { Logger } from '../logging/logger';
import type { Confirmer } from '../notifications/confirmer';
import type { Toaster } from '../notifications/toaster';
import type { ErrorReporter } from '../reporting/error-reporter';
import type { KeyValueStorage } from '../storage/key-value-storage';
import type { FoundationConfig } from './foundation-config';
import { installConfig, installConfirm, installFeatureFlags, installStorage, installToasts } from './services';
import type { WireHttpClientTools } from './wire-http-client';
import { wireHttpClient } from './wire-http-client';
import type { WiredObservability } from './wire-observability';
import { wireObservability } from './wire-observability';

/**
 * The resolved platform seams the core reads.
 */
export interface PlatformCore {
    /** The resolved fetch seam. */
    readonly fetchFn: typeof fetch;
}

/**
 * The core boot phases, in execution order.
 */
export type FoundationCorePhase =
    | 'runtime-environment'
    | 'configuration'
    | 'storage'
    | 'feature-flags'
    | 'notifications'
    | 'observability'
    | 'http-client';

/**
 * The configuration surface handed to the platform's module-registration step.
 */
export interface FoundationCoreRegistration<T extends FoundationConfig> {
    /** The installed configuration repository. */
    readonly config: ConfigRepository<T & Record<string, unknown>>;

    /** The constructed environment. */
    readonly environment: Environment;
}

/**
 * Construction options for {@link bootFoundationCore}.
 */
export interface FoundationCoreOptions<T extends FoundationConfig> {
    /** Runtime document fetched at boot; omitted, runtime values are empty. */
    readonly runtime?: RuntimeEnvironmentSource;

    /** Builds the environment over the fetched runtime values. */
    readonly createEnvironment: (runtime: Readonly<Record<string, string>>) => Environment;

    /** Configuration definition over the environment; the result is frozen. */
    readonly define: (environment: Environment) => T;

    /** The storage adapter to install; resolved by the kernel. */
    readonly storage: KeyValueStorage;

    /** The toast notifier to install; resolved by the kernel. */
    readonly toasts: Toaster;

    /** The confirmation prompter to install; resolved by the kernel. */
    readonly confirm: Confirmer;

    /** Feature-flag adapter factory; wins over the config-delivered default. */
    readonly featureFlags?: (settings: Readonly<T>) => FeatureFlags;

    /** Observability factories; each wins over the environment default. */
    readonly observability?: {
        /** Error-reporter factory. */
        readonly reporter?: (settings: Readonly<T>) => ErrorReporter;

        /** Analytics-tracker factory. */
        readonly analytics?: (settings: Readonly<T>) => AnalyticsTracker;

        /** Logger factory. */
        readonly logger?: (settings: Readonly<T>) => Logger;
    };

    /** HTTP client construction options. */
    readonly http?: {
        /** Preset-level interceptors, run before every module contribution. */
        readonly interceptors?: readonly RequestInterceptor[];

        /** Full replacement of the preset response-error handler. */
        readonly onResponseError?: ResponseErrorHandler;

        /** Arms the default handler's toast. */
        readonly unexpectedErrorToastKey?: string;

        /** Full adapter override; receives the resolved construction inputs. */
        readonly client?: (tools: WireHttpClientTools<T>) => HttpClient;
    };

    /** Module registration; runs once, after the core installs, before the HTTP client. */
    readonly collectHttpContributions: (registration: FoundationCoreRegistration<T>) => ModuleHttpContributions;

    /** Phase observer; the kernel threads its own boot recorder through. */
    readonly onPhase?: (phase: FoundationCorePhase) => void;
}

/**
 * Everything the core boot produced, for the kernel's platform phases.
 */
export interface FoundationCore<T extends FoundationConfig> {
    /** The constructed environment. */
    readonly environment: Environment;

    /** The installed configuration repository. */
    readonly repository: ConfigRepository<T & Record<string, unknown>>;

    /** The frozen configuration tree. */
    readonly settings: Readonly<T>;

    /** The installed feature-flag adapter. */
    readonly flags: FeatureFlags;

    /** The installed observability services and breadcrumb trail. */
    readonly observability: WiredObservability;

    /** The installed HTTP client. */
    readonly http: HttpClient;
}

/**
 * Run the platform-agnostic boot phases and install the core services.
 *
 * A failure rejects with the original error and leaves in place the services
 * installed so far, alongside any from an earlier boot that this one had not
 * yet replaced.
 *
 * @throws {RuntimeEnvironmentError} when a configured runtime document cannot
 * be loaded
 */
export async function bootFoundationCore<T extends FoundationConfig>(
    options: FoundationCoreOptions<T>,
    platform: PlatformCore,
): Promise<FoundationCore<T>> {
    options.onPhase?.('runtime-environment');

    const runtime =
        options.runtime === undefined ? {} : await fetchRuntimeEnvironment(options.runtime, platform.fetchFn);

    options.onPhase?.('configuration');

    const environment = options.createEnvironment(runtime);
    const repository = new ConfigRepository(options.define(environment) as T & Record<string, unknown>);
    const settings: Readonly<T> = repository.all();

    installConfig(repository);

    options.onPhase?.('storage');

    installStorage(options.storage);

    options.onPhase?.('feature-flags');

    const flags = options.featureFlags?.(settings) ?? new StaticFeatureFlags(settings.featureFlags.flags);

    installFeatureFlags(flags);

    options.onPhase?.('notifications');

    installToasts(options.toasts);
    installConfirm(options.confirm);

    options.onPhase?.('observability');

    const observability = wireObservability({
        config: settings,
        ...(options.observability?.reporter === undefined ? {} : { reporter: options.observability.reporter }),
        ...(options.observability?.analytics === undefined ? {} : { analytics: options.observability.analytics }),
        ...(options.observability?.logger === undefined ? {} : { logger: options.observability.logger }),
    });

    const contributions = options.collectHttpContributions({ config: repository, environment });

    options.onPhase?.('http-client');

    const http = wireHttpClient({
        config: settings,
        fetchFn: platform.fetchFn,
        contributions,
        ...(options.http?.interceptors === undefined ? {} : { interceptors: options.http.interceptors }),
        ...(options.http?.onResponseError === undefined ? {} : { onResponseError: options.http.onResponseError }),
        ...(options.http?.unexpectedErrorToastKey === undefined
            ? {}
            : { unexpectedErrorToastKey: options.http.unexpectedErrorToastKey }),
        ...(options.http?.client === undefined ? {} : { client: options.http.client }),
    });

    return { environment, repository, settings, flags, observability, http };
}
