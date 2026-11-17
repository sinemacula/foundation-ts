/**
 * No-op analytics tracker, the default when no provider is configured.
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
     * Discard the event.
     */
    track(_event: string, _properties?: Readonly<Record<string, unknown>>): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the page view.
     */
    page(_name: string, _properties?: Readonly<Record<string, unknown>>): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the identity.
     */
    identify(_id: string, _traits?: Readonly<Record<string, unknown>>): void {
        // Intentionally empty: no provider is configured.
    }

    /**
     * Discard the reset.
     */
    reset(): void {
        // Intentionally empty: no provider is configured.
    }
}
