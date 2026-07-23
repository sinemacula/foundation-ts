/**
 * Page tracking installer.
 *
 * Registers an after-navigation hook that fires a page-view event for every
 * completed navigation, and optionally records the navigation as a breadcrumb
 * on the session trail. The navigation source is a structural port, so any
 * router exposing a matching `afterEach` satisfies it (vue-router on web).
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
    /** The route's name, when it has one. */
    readonly name?: unknown;

    /** The route's path. */
    readonly path: string;

    /** The route's full path, including query and hash. */
    readonly fullPath: string;
}

/**
 * The navigation source the page tracker attaches to.
 */
export interface NavigationHooks {
    /**
     * Register a hook fired after every completed navigation.
     *
     * @param cb - invoked with the destination and origin routes
     * @returns a teardown that removes the hook
     */
    afterEach(cb: (to: RouteTarget, from: RouteTarget) => void): () => void;
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
}

/**
 * Install an after-navigation hook that tracks page views and records
 * breadcrumbs.
 *
 * @param options - the navigation source, tracker and optional breadcrumb trail
 * @returns a teardown that removes the hook; safe to call more than once
 */
export function installPageTracking(options: PageTrackingOptions): () => void {
    const { router, tracker, trail } = options;

    return router.afterEach((to, from) => {
        tracker.page(String(to.name ?? to.path), { path: to.fullPath });

        if (trail !== undefined) {
            trail.add({ category: 'navigation', message: `${from.fullPath} -> ${to.fullPath}` });
        }
    });
}
