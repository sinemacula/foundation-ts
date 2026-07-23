/**
 * Analytics tracker port.
 *
 * Vendor SDKs (Segment, Amplitude, Mixpanel, PostHog, …) are adapters that
 * implement this interface. The application never imports a vendor SDK directly
 * - it depends only on this port so that the provider can be swapped, stubbed
 *   in tests, or silenced without touching application code.
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
     *
     * @param event - the event name
     * @param properties - additional structured properties to attach
     */
    track(event: string, properties?: Readonly<Record<string, unknown>>): void;

    /**
     * Record a page view with optional properties.
     *
     * @param name - the page name or path
     * @param properties - additional structured properties to attach
     */
    page(name: string, properties?: Readonly<Record<string, unknown>>): void;

    /**
     * Associate subsequent events with a specific user.
     *
     * @param id - the stable user identifier
     * @param traits - additional user attributes to record
     */
    identify(id: string, traits?: Readonly<Record<string, unknown>>): void;

    /**
     * Clear the current user identity, typically on sign-out.
     */
    reset(): void;
}
