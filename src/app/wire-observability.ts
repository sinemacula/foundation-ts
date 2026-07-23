/**
 * Observability wiring unit for the bootstrap preset.
 *
 * Resolves the error reporter, analytics tracker, and logger from the
 * application's optional factories, installs each instance into its base
 * service holder, and creates the breadcrumb trail. Without a factory the local
 * environment gets console adapters and every other environment gets the null
 * adapters. The instances and trail are returned so the orchestrator can wire
 * global error handling and page tracking over them without ambient reads.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { AnalyticsTracker } from '../analytics/analytics-tracker';
import { ConsoleAnalyticsTracker } from '../analytics/console-analytics-tracker';
import { NullAnalyticsTracker } from '../analytics/null-analytics-tracker';
import { ConsoleLogger } from '../logging/console-logger';
import type { Logger } from '../logging/logger';
import { NullLogger } from '../logging/null-logger';
import { BreadcrumbTrail } from '../reporting/breadcrumb-trail';
import { ConsoleErrorReporter } from '../reporting/console-error-reporter';
import type { ErrorReporter } from '../reporting/error-reporter';
import { NullErrorReporter } from '../reporting/null-error-reporter';
import { installAnalytics, installLogger, installReporting } from './services';
import type { FoundationConfig } from './foundation-config';

/**
 * Inputs for {@link wireObservability}.
 */
export interface WireObservabilityOptions<T extends FoundationConfig> {
    /** The frozen application configuration. */
    readonly config: Readonly<T>;

    /** Error-reporter factory; wins over the environment default. */
    readonly reporter?: (settings: Readonly<T>) => ErrorReporter;

    /** Analytics-tracker factory; wins over the environment default. */
    readonly analytics?: (settings: Readonly<T>) => AnalyticsTracker;

    /** Logger factory; wins over the environment default. */
    readonly logger?: (settings: Readonly<T>) => Logger;
}

/**
 * The installed observability instances plus the breadcrumb trail.
 */
export interface WiredObservability {
    /** The installed error reporter. */
    readonly reporter: ErrorReporter;

    /** The installed analytics tracker. */
    readonly analytics: AnalyticsTracker;

    /** The installed logger. */
    readonly logger: Logger;

    /** The breadcrumb trail feeding error handling and page tracking. */
    readonly trail: BreadcrumbTrail;
}

/**
 * Resolve and install the observability services.
 *
 * @param options - the frozen configuration and optional adapter factories
 * @returns the installed instances plus the breadcrumb trail
 */
export function wireObservability<T extends FoundationConfig>(options: WireObservabilityOptions<T>): WiredObservability {
    const isLocal = options.config.app.environment === 'local';

    const reporter: ErrorReporter =
        options.reporter?.(options.config) ?? (isLocal ? new ConsoleErrorReporter() : new NullErrorReporter());
    const tracker: AnalyticsTracker =
        options.analytics?.(options.config) ?? (isLocal ? new ConsoleAnalyticsTracker() : new NullAnalyticsTracker());
    const logging: Logger = options.logger?.(options.config) ?? (isLocal ? new ConsoleLogger() : new NullLogger());
    const trail = new BreadcrumbTrail();

    installReporting(reporter);
    installAnalytics(tracker);
    installLogger(logging);

    return { reporter, analytics: tracker, logger: logging, trail };
}
