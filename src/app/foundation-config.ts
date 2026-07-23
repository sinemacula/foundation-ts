/**
 * Structural configuration contract read by the bootstrap preset.
 *
 * The preset reads only this slice of the application's configuration tree;
 * applications define richer trees and satisfy the contract structurally. Flag
 * values reuse the feature-flag port's `FlagValue` so a config-delivered flag
 * set feeds the default static adapter without conversion.
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

    /** Locale identity: default, enabled list, and per-locale metadata. */
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
