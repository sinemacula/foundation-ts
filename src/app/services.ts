/**
 * Base application service singletons, each with an install/accessor pair.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { AnalyticsTracker } from '../analytics/analytics-tracker';
import type { ConfigRepository } from '../config/config-repository';
import type { FeatureFlags } from '../feature-flags/feature-flags';
import type { HttpClient } from '../http/http-client';
import type { Logger } from '../logging/logger';
import type { Confirmer } from '../notifications/confirmer';
import type { Toaster } from '../notifications/toaster';
import type { RealtimeConnection } from '../realtime/realtime-connection';
import type { ErrorReporter } from '../reporting/error-reporter';
import type { KeyValueStorage } from '../storage/key-value-storage';
import { createServiceHolder } from '../support/service-holder';
import type { ColorSchemeService } from '../theme/color-scheme-service';

const configHolder = createServiceHolder<ConfigRepository<Record<string, unknown>>>('configuration');
const httpHolder = createServiceHolder<HttpClient>('http client');
const storageHolder = createServiceHolder<KeyValueStorage>('application storage');
const toastsHolder = createServiceHolder<Toaster>('toast service');
const confirmHolder = createServiceHolder<Confirmer>('confirmation dialog service');
const reportingHolder = createServiceHolder<ErrorReporter>('error reporter');
const analyticsHolder = createServiceHolder<AnalyticsTracker>('analytics tracker');
const loggerHolder = createServiceHolder<Logger>('logger');
const featureFlagsHolder = createServiceHolder<FeatureFlags>('feature-flag adapter');
const colorSchemeHolder = createServiceHolder<ColorSchemeService>('colour scheme service');
const realtimeHolder = createServiceHolder<RealtimeConnection>('realtime connection');

const baseHolders = [
    configHolder,
    httpHolder,
    storageHolder,
    toastsHolder,
    confirmHolder,
    reportingHolder,
    analyticsHolder,
    loggerHolder,
    featureFlagsHolder,
    colorSchemeHolder,
    realtimeHolder,
] as const;

/**
 * Install the configuration repository. Called once at boot.
 */
export function installConfig(instance: ConfigRepository<Record<string, unknown>>): void {
    configHolder.install(instance);
}

/**
 * The frozen configuration tree, cast to the application's shape.
 *
 * @throws {SupportError} when called before {@link installConfig}
 */
export function appConfig<T = unknown>(): Readonly<T> {
    return configHolder.resolve().all() as Readonly<T>;
}

/**
 * The active configuration repository, cast to the application's shape.
 *
 * @throws {SupportError} when called before {@link installConfig}
 */
export function appConfigRepository<
    T extends Record<string, unknown> = Record<string, unknown>,
>(): ConfigRepository<T> {
    return configHolder.resolve() as ConfigRepository<T>;
}

/**
 * Install the HTTP client. Called once at boot.
 */
export function installApi(instance: HttpClient): void {
    httpHolder.install(instance);
}

/**
 * The active HTTP client.
 *
 * @throws {SupportError} when called before {@link installApi}
 */
export function api(): HttpClient {
    return httpHolder.resolve();
}

/**
 * Install the storage adapter. Called once at boot.
 */
export function installStorage(instance: KeyValueStorage): void {
    storageHolder.install(instance);
}

/**
 * The active storage adapter.
 *
 * @throws {SupportError} when called before {@link installStorage}
 */
export function appStorage(): KeyValueStorage {
    return storageHolder.resolve();
}

/**
 * Install the toast notification service. Called once at boot.
 */
export function installToasts(instance: Toaster): void {
    toastsHolder.install(instance);
}

/**
 * The active toast notification service.
 *
 * @throws {SupportError} when called before {@link installToasts}
 */
export function toasts(): Toaster {
    return toastsHolder.resolve();
}

/**
 * Install the confirmation dialog service. Called once at boot.
 */
export function installConfirm(instance: Confirmer): void {
    confirmHolder.install(instance);
}

/**
 * The active confirmation dialog service.
 *
 * @throws {SupportError} when called before {@link installConfirm}
 */
export function confirmDialogs(): Confirmer {
    return confirmHolder.resolve();
}

/**
 * Install the error reporter. Called once at boot.
 */
export function installReporting(instance: ErrorReporter): void {
    reportingHolder.install(instance);
}

/**
 * The active error reporter.
 *
 * @throws {SupportError} when called before {@link installReporting}
 */
export function reporting(): ErrorReporter {
    return reportingHolder.resolve();
}

/**
 * Install the analytics tracker. Called once at boot.
 */
export function installAnalytics(instance: AnalyticsTracker): void {
    analyticsHolder.install(instance);
}

/**
 * The active analytics tracker.
 *
 * @throws {SupportError} when called before {@link installAnalytics}
 */
export function analytics(): AnalyticsTracker {
    return analyticsHolder.resolve();
}

/**
 * Install the logger. Called once at boot.
 */
export function installLogger(instance: Logger): void {
    loggerHolder.install(instance);
}

/**
 * The active logger.
 *
 * @throws {SupportError} when called before {@link installLogger}
 */
export function logger(): Logger {
    return loggerHolder.resolve();
}

/**
 * Install the feature-flag adapter. Called once at boot.
 */
export function installFeatureFlags(instance: FeatureFlags): void {
    featureFlagsHolder.install(instance);
}

/**
 * The active feature-flag adapter.
 *
 * @throws {SupportError} when called before {@link installFeatureFlags}
 */
export function featureFlags(): FeatureFlags {
    return featureFlagsHolder.resolve();
}

/**
 * Install the colour-scheme service. Called once at boot.
 */
export function installColorScheme(instance: ColorSchemeService): void {
    colorSchemeHolder.install(instance);
}

/**
 * The active colour-scheme service.
 *
 * @throws {SupportError} when called before {@link installColorScheme}
 */
export function colorScheme(): ColorSchemeService {
    return colorSchemeHolder.resolve();
}

/**
 * Install the realtime connection. Called once at boot, when the application
 * opts in.
 */
export function installRealtime(instance: RealtimeConnection): void {
    realtimeHolder.install(instance);
}

/**
 * The active realtime connection.
 *
 * @throws {SupportError} when called before {@link installRealtime}
 */
export function realtime(): RealtimeConnection {
    return realtimeHolder.resolve();
}

/**
 * Clear every service holder back to its uninstalled state. Test-only.
 */
export function resetFoundationServices(): void {
    for (const holder of baseHolders) {
        holder.reset();
    }
}
