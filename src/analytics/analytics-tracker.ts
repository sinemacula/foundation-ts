/**
 * Analytics tracker port that vendor SDK adapters implement.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Contract that every analytics adapter must satisfy.
 */
export interface AnalyticsTracker {
    /**
     * Record a named user action with optional properties.
     */
    track(event: string, properties?: Readonly<Record<string, unknown>>): void;

    /**
     * Record a page view with optional properties.
     *
     * @param name - the page name or path
     */
    page(name: string, properties?: Readonly<Record<string, unknown>>): void;

    /**
     * Associate subsequent events with a specific user.
     *
     * @param id - the stable user identifier
     */
    identify(id: string, traits?: Readonly<Record<string, unknown>>): void;

    /**
     * Clear the current user identity, typically on sign-out.
     */
    reset(): void;
}
