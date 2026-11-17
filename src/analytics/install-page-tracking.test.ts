/**
 * Unit tests for install-page-tracking.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { AnalyticsTracker } from './analytics-tracker';
import type { NavigationHooks, RouteTarget } from './install-page-tracking';
import { installPageTracking } from './install-page-tracking';
import { BreadcrumbTrail } from '../reporting/breadcrumb-trail';

/** One recorded page() invocation. */
interface PageCall {
    /** The page name tracked. */
    readonly name: string;

    /** The properties tracked with it. */
    readonly properties: Readonly<Record<string, unknown>> | undefined;
}

/** An analytics tracker that records every page() call. */
interface StubTracker extends AnalyticsTracker {
    /** Every page() invocation, in order. */
    readonly pageCalls: PageCall[];
}

/**
 * Build a tracker that records page calls.
 */
function makeTracker(): StubTracker {
    const pageCalls: PageCall[] = [];

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

/**
 * Build a tracker whose page() throws the given error.
 */
function makeThrowingTracker(error: Error): AnalyticsTracker {
    return {
        track: vi.fn(),
        page: () => {
            throw error;
        },
        identify: vi.fn(),
        reset: vi.fn(),
    };
}

/** Navigation hooks plus controls to drive and inspect them. */
interface HooksFixture {
    /** The hooks handed to the tracking install. */
    readonly hooks: NavigationHooks;

    /** Simulate a navigation, failed when `failure` is given. */
    readonly navigate: (to: RouteTarget, from: RouteTarget, failure?: unknown) => void;

    /** How many times the after-each registration was torn down. */
    readonly teardownCount: () => number;
}

/**
 * Build navigation hooks the test drives by hand.
 */
function makeHooks(): HooksFixture {
    let handler: ((to: RouteTarget, from: RouteTarget, failure?: unknown) => void) | null = null;
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
        navigate: (to, from, failure) => handler?.(to, from, failure),
        teardownCount: () => teardowns,
    };
}

const home: RouteTarget = { name: 'home', path: '/' };
const about: RouteTarget = { name: 'about', path: '/about' };

describe('installPageTracking', () => {
    describe('page calls', () => {
        it('tracks the route name and path', () => {
            const { hooks, navigate } = makeHooks();
            const tracker = makeTracker();

            installPageTracking({ router: hooks, tracker });
            navigate(about, home);

            expect(tracker.pageCalls).toStrictEqual([{ name: 'about', properties: { path: '/about' } }]);
        });

        it.each([
            ['a string name', 'home', 'home'],
            ['a described symbol', Symbol('home'), 'home'],
            ['an undescribed symbol', Symbol(), '/fallback'],
            ['an empty-description symbol', Symbol(''), '/fallback'],
            ['an empty string', '', '/fallback'],
            ['no name', undefined, '/fallback'],
            ['a null name', null, '/fallback'],
            ['a numeric name', 7, '/fallback'],
        ])('names the page from %s', (_, name, expected) => {
            const { hooks, navigate } = makeHooks();
            const tracker = makeTracker();

            installPageTracking({ router: hooks, tracker });
            navigate({ name, path: '/fallback' }, home);

            expect(tracker.pageCalls[0]?.name).toBe(expected);
        });

        it('tracks every navigation', () => {
            const { hooks, navigate } = makeHooks();
            const tracker = makeTracker();

            installPageTracking({ router: hooks, tracker });
            navigate(home, about);
            navigate(about, home);

            expect(tracker.pageCalls.map(call => call.name)).toStrictEqual(['home', 'about']);
        });

        it('tracks without a trail', () => {
            const { hooks, navigate } = makeHooks();
            const tracker = makeTracker();
            const onError = vi.fn();

            installPageTracking({ router: hooks, tracker, onError });
            navigate(about, home);

            expect(tracker.pageCalls).toHaveLength(1);
            expect(onError).not.toHaveBeenCalled();
        });
    });

    describe('query strings and hashes', () => {
        it('records only the path in page calls and breadcrumbs', () => {
            const { hooks, navigate } = makeHooks();
            const tracker = makeTracker();
            const trail = new BreadcrumbTrail(50, () => 0);

            const to = { name: 'callback', path: '/auth/callback', fullPath: '/auth/callback?code=abc&state=xyz#frag' };
            const from = { name: 'home', path: '/', fullPath: '/?ref=mail' };

            installPageTracking({ router: hooks, tracker, trail });
            navigate(to, from);

            expect(tracker.pageCalls).toStrictEqual([{ name: 'callback', properties: { path: '/auth/callback' } }]);
            expect(trail.list().map(entry => entry.message)).toStrictEqual(['/ -> /auth/callback']);
        });
    });

    describe('failed navigations', () => {
        it.each([
            ['an aborted navigation', { type: 4 }],
            ['a cancelled navigation', { type: 8 }],
            ['a duplicated navigation', { type: 16 }],
            ['an error', new Error('guard failed')],
        ])('records nothing for %s', (_, failure) => {
            const { hooks, navigate } = makeHooks();
            const tracker = makeTracker();
            const trail = new BreadcrumbTrail(50, () => 0);

            installPageTracking({ router: hooks, tracker, trail });
            navigate(about, home, failure);

            expect(tracker.pageCalls).toStrictEqual([]);
            expect(trail.list()).toStrictEqual([]);
        });

        it.each([undefined, null])('records a navigation whose failure is %s', failure => {
            const { hooks, navigate } = makeHooks();
            const tracker = makeTracker();
            const trail = new BreadcrumbTrail(50, () => 0);

            installPageTracking({ router: hooks, tracker, trail });
            navigate(about, home, failure);

            expect(tracker.pageCalls).toHaveLength(1);
            expect(trail.list()).toHaveLength(1);
        });

        it('accepts a vue-router style hook registration', () => {
            /** The structural shape of a vue-router resolved route. */
            interface VueRouterRoute {
                /** The route record name. */
                readonly name: string | symbol | undefined;

                /** The route path. */
                readonly path: string;

                /** The path with query and hash. */
                readonly fullPath: string;
            }

            /** The structural shape of vue-router's after-each registration. */
            interface VueRouterHooks {
                /**
                 * Register a hook vue-router calls after every navigation.
                 */
                afterEach(guard: (to: VueRouterRoute, from: VueRouterRoute, failure?: Error) => unknown): () => void;
            }

            expectTypeOf<VueRouterHooks>().toExtend<NavigationHooks>();
        });
    });

    describe('breadcrumbs', () => {
        it('records a navigation breadcrumb from one path to the other', () => {
            const { hooks, navigate } = makeHooks();
            const tracker = makeTracker();
            const trail = new BreadcrumbTrail(50, () => 0);

            installPageTracking({ router: hooks, tracker, trail });
            navigate(about, home);

            expect(trail.list()).toStrictEqual([{ category: 'navigation', message: '/ -> /about', timestamp: 0 }]);
        });
    });

    describe('throwing collaborators', () => {
        it('reports a throwing tracker and keeps the breadcrumb', () => {
            const error = new Error('blocked');
            const { hooks, navigate } = makeHooks();
            const trail = new BreadcrumbTrail(50, () => 0);
            const onError = vi.fn();

            installPageTracking({ router: hooks, tracker: makeThrowingTracker(error), trail, onError });

            expect(() => navigate(about, home)).not.toThrow();
            expect(trail.list()).toHaveLength(1);
            expect(onError).toHaveBeenCalledExactlyOnceWith(error);
        });

        it('reports a throwing trail clock and still tracks the page', () => {
            const error = new Error('clock failed');
            const { hooks, navigate } = makeHooks();
            const tracker = makeTracker();
            const onError = vi.fn();
            const trail = new BreadcrumbTrail(50, () => {
                throw error;
            });

            installPageTracking({ router: hooks, tracker, trail, onError });
            navigate(about, home);

            expect(tracker.pageCalls).toHaveLength(1);
            expect(onError).toHaveBeenCalledExactlyOnceWith(error);
        });

        it('reports the trail failure before the tracker failure', () => {
            const trailError = new Error('clock failed');
            const trackerError = new Error('blocked');
            const { hooks, navigate } = makeHooks();
            const onError = vi.fn();
            const trail = new BreadcrumbTrail(50, () => {
                throw trailError;
            });

            installPageTracking({ router: hooks, tracker: makeThrowingTracker(trackerError), trail, onError });
            navigate(about, home);

            expect(onError.mock.calls).toStrictEqual([[trailError], [trackerError]]);
        });

        it.each([
            ['no sink', undefined],
            [
                'a throwing sink',
                () => {
                    throw new Error('sink failed');
                },
            ],
        ])('never throws into the router with %s', (_, onError) => {
            const { hooks, navigate } = makeHooks();
            const trail = new BreadcrumbTrail(50, () => {
                throw new Error('clock failed');
            });

            installPageTracking({
                router: hooks,
                tracker: makeThrowingTracker(new Error('blocked')),
                trail,
                ...(onError === undefined ? {} : { onError }),
            });

            expect(() => navigate(about, home)).not.toThrow();
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
