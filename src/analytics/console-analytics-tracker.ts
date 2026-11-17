/**
 * Development analytics tracker that logs every call to the console.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { AnalyticsTracker } from './analytics-tracker';

/**
 * An analytics tracker that logs every call with `console.info`.
 */
export class ConsoleAnalyticsTracker implements AnalyticsTracker {
    /**
     * Log the event and its properties.
     */
    track(event: string, properties?: Readonly<Record<string, unknown>>): void {
        console.info('[AnalyticsTracker] track', event, ...(properties !== undefined ? [properties] : []));
    }

    /**
     * Log the page view and its properties.
     */
    page(name: string, properties?: Readonly<Record<string, unknown>>): void {
        console.info('[AnalyticsTracker] page', name, ...(properties !== undefined ? [properties] : []));
    }

    /**
     * Log the user id and traits.
     */
    identify(id: string, traits?: Readonly<Record<string, unknown>>): void {
        console.info('[AnalyticsTracker] identify', id, ...(traits !== undefined ? [traits] : []));
    }

    /**
     * Log the identity reset.
     */
    reset(): void {
        console.info('[AnalyticsTracker] reset');
    }
}
