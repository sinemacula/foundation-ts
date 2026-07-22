/**
 * Unit tests for install-page-tracking.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import type { AnalyticsTracker } from './analytics-tracker';
import type { NavigationHooks, RouteTarget } from './install-page-tracking';
import { installPageTracking } from './install-page-tracking';
import { BreadcrumbTrail } from '../reporting/breadcrumb-trail';

function makeTracker(): AnalyticsTracker & {
    pageCalls: Array<{ name: string; properties: Readonly<Record<string, unknown>> | undefined }>;
} {
    const pageCalls: Array<{ name: string; properties: Readonly<Record<string, unknown>> | undefined }> = [];

    return {
        pageCalls,
        track: vi.fn(),
        page(name: string, properties?: Readonly<Record<string, unknown>>) {
            pageCalls.push({ name, properties });
        },
        identify: vi.fn(),
        reset: vi.fn(),
    };
}

function makeHooks(): {
    hooks: NavigationHooks;
    navigate: (to: RouteTarget, from: RouteTarget) => void;
    teardownCount: () => number;
} {
    let handler: ((to: RouteTarget, from: RouteTarget) => void) | null = null;
    let teardowns = 0;

    return {
        hooks: {
            afterEach(cb) {
                handler = cb;

                return () => {
                    teardowns += 1;
                };
            },
        },
        navigate: (to, from) => handler?.(to, from),
        teardownCount: () => teardowns,
    };
}

const home: RouteTarget = { name: 'home', path: '/', fullPath: '/' };
const about: RouteTarget = { name: 'about', path: '/about', fullPath: '/about' };

describe('installPageTracking', () => {
    describe('page calls', () => {
        it('calls tracker.page with the route name and fullPath after navigation', () => {
            const { hooks, navigate } = makeHooks();
            const tracker = makeTracker();

            installPageTracking({ router: hooks, tracker });
            navigate(about, home);

            expect(tracker.pageCalls[0]).toStrictEqual({ name: 'about', properties: { path: '/about' } });
        });

        it('falls back to to.path when the route has no name', () => {
            const { hooks, navigate } = makeHooks();
            const tracker = makeTracker();

            installPageTracking({ router: hooks, tracker });
            navigate({ name: undefined, path: '/no-name', fullPath: '/no-name' }, home);

            expect(tracker.pageCalls[0]?.name).toBe('/no-name');
        });

        it('calls tracker.page on every navigation', () => {
            const { hooks, navigate } = makeHooks();
            const tracker = makeTracker();

            installPageTracking({ router: hooks, tracker });
            navigate(home, about);
            navigate(about, home);

            expect(tracker.pageCalls).toHaveLength(2);
        });

        it('does not record a breadcrumb when no trail is provided', () => {
            const { hooks, navigate } = makeHooks();
            const tracker = makeTracker();

            installPageTracking({ router: hooks, tracker });
            navigate(about, home);

            expect(tracker.pageCalls).toHaveLength(1);
        });
    });

    describe('breadcrumb trail (trail provided)', () => {
        it('records a navigation breadcrumb when a trail is provided', () => {
            const { hooks, navigate } = makeHooks();
            const tracker = makeTracker();
            const trail = new BreadcrumbTrail(50, () => 0);

            installPageTracking({ router: hooks, tracker, trail });
            navigate(about, home);

            expect(trail.list()).toHaveLength(1);
            expect(trail.list()[0]?.category).toBe('navigation');
        });

        it('breadcrumb message contains from and to fullPath', () => {
            const { hooks, navigate } = makeHooks();
            const tracker = makeTracker();
            const trail = new BreadcrumbTrail(50, () => 0);

            installPageTracking({ router: hooks, tracker, trail });
            navigate(about, home);

            expect(trail.list()[0]?.message).toBe('/ -> /about');
        });
    });

    describe('teardown', () => {
        it('returns the hook teardown', () => {
            const { hooks, teardownCount } = makeHooks();
            const tracker = makeTracker();

            const teardown = installPageTracking({ router: hooks, tracker });
            teardown();

            expect(teardownCount()).toBe(1);
        });
    });
});
