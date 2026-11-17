/**
 * Page-view tracking for any router exposing a vue-router style `afterEach`.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { AnalyticsTracker } from './analytics-tracker';
import type { BreadcrumbTrail } from '../reporting/breadcrumb-trail';

/**
 * The subset of a resolved route the page tracker reads.
 */
export interface RouteTarget {
    /** The route's name: a string or symbol when the route is named. */
    readonly name?: unknown;

    /** The route's path, without query or hash. */
    readonly path: string;
}

/**
 * The navigation source the page tracker attaches to.
 */
export interface NavigationHooks {
    /**
     * Register a hook fired after every navigation, successful or not.
     *
     * @param cb - invoked with the destination and origin routes, and the
     * failure when the navigation did not complete
     * @returns a teardown that removes the hook
     */
    afterEach(cb: (to: RouteTarget, from: RouteTarget, failure?: unknown) => void): () => void;
}

/**
 * Options for installing the page-tracking hook.
 */
export interface PageTrackingOptions {
    /** The navigation source to attach the after-navigation hook to. */
    readonly router: NavigationHooks;

    /** The tracker that receives every page-view call. */
    readonly tracker: AnalyticsTracker;

    /** Optional breadcrumb trail; when present each navigation is appended. */
    readonly trail?: BreadcrumbTrail;

    /** Receives a synchronous trail or tracker throw (never a rejected promise); a throwing sink is ignored. */
    readonly onError?: (error: unknown) => void;
}

/**
 * Track a page view, and a breadcrumb when a trail is given, after every
 * successful navigation. Only the path is recorded: query strings and hashes
 * can carry tokens and personal data.
 *
 * @returns the router's teardown for the hook
 */
export function installPageTracking(options: PageTrackingOptions): () => void {
    const { router, tracker, trail, onError = () => undefined } = options;

    return router.afterEach((to, from, failure) => {
        if (failure !== undefined && failure !== null) {
            return;
        }

        try {
            trail?.add({ category: 'navigation', message: `${from.path} -> ${to.path}` });
        } catch (error) {
            report(onError, error);
        }

        try {
            tracker.page(pageName(to), { path: to.path });
        } catch (error) {
            report(onError, error);
        }
    });
}

/**
 * Pass a contained error to the sink, ignoring a throwing sink.
 */
function report(onError: (error: unknown) => void, error: unknown): void {
    try {
        onError(error);
    } catch {
        // The sink is the last resort; nothing is left to report to.
    }
}

/**
 * Name a page by its route name, or by its path when the route is unnamed.
 */
function pageName(route: RouteTarget): string {
    const { name } = route;
    const label = typeof name === 'symbol' ? name.description : name;

    return typeof label === 'string' && label !== '' ? label : route.path;
}
