/**
 * No-op analytics tracker adapter.
 *
 * Used as the default when no analytics provider is configured. All methods are
 * intentionally empty so that calls are silently ignored rather than throwing
 * or logging.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { AnalyticsTracker } from './analytics-tracker';

/**
 * An analytics tracker that discards every call without side effects.
 */
export class NullAnalyticsTracker implements AnalyticsTracker {
    /**
     * Discard the event; the null tracker records nothing.
     */
    track(_event: string, _properties?: Readonly<Record<string, unknown>>): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the page view; the null tracker records nothing.
     */
    page(_name: string, _properties?: Readonly<Record<string, unknown>>): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the identity; the null tracker records nothing.
     */
    identify(_id: string, _traits?: Readonly<Record<string, unknown>>): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the reset; the null tracker records nothing.
     */
    reset(): void {
        // Intentionally empty: no provider is configured.
    }
}
