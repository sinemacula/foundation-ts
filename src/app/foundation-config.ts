/**
 * Structural configuration contract read by the bootstrap preset.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { FlagValue } from '../feature-flags/feature-flags';

/**
 * The configuration slice the preset requires from the application.
 */
export interface FoundationConfig {
    /** HTTP client construction inputs. */
    readonly api: {
        /** The base URL every request is resolved against. */
        readonly baseUrl: string;

        /** The per-request timeout in milliseconds. */
        readonly timeout: number;
    };

    /** Application identity read by observability, titles, and monitors. */
    readonly app: {
        /** The application's display name. */
        readonly name: string;

        /** The deployment environment name. */
        readonly environment: string;

        /** The deployed application version. */
        readonly version: string;
    };

    /** Config-delivered flag set feeding the default static adapter. */
    readonly featureFlags: {
        /** The flag values keyed by flag name. */
        readonly flags: Readonly<Record<string, FlagValue>>;
    };

    /** Locale configuration. */
    readonly locales: {
        /** The default locale applied before any preference resolves. */
        readonly default: string;

        /** The locales the application enables, as BCP 47 tags. */
        readonly enabled: readonly string[];

        /** Per-locale metadata keyed by locale tag. */
        readonly supported: Readonly<
            Record<
                string,
                {
                    /** The locale's text direction. */
                    readonly direction: 'ltr' | 'rtl';
                }
            >
        >;
    };
}
