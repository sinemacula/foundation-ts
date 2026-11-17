/**
 * Unit tests for breadcrumb-trail.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { BreadcrumbTrail } from './breadcrumb-trail';

describe('BreadcrumbTrail', () => {
    describe('add / list', () => {
        it('returns an empty list before any breadcrumbs are added', () => {
            const trail = new BreadcrumbTrail();

            expect(trail.list()).toStrictEqual([]);
        });

        it('stamps a breadcrumb with the clock time', () => {
            const trail = new BreadcrumbTrail(50, () => 1_000);

            trail.add({ category: 'ui', message: 'button clicked' });

            expect(trail.list()).toStrictEqual([{ category: 'ui', message: 'button clicked', timestamp: 1_000 }]);
        });

        it('records optional data', () => {
            const trail = new BreadcrumbTrail(50, () => 2_000);

            trail.add({ category: 'http', message: 'GET /api', data: { status: 200 } });

            expect(trail.list()[0]).toStrictEqual({
                category: 'http',
                message: 'GET /api',
                data: { status: 200 },
                timestamp: 2_000,
            });
        });

        it('preserves insertion order', () => {
            let t = 0;
            const trail = new BreadcrumbTrail(50, () => ++t);

            trail.add({ category: 'a', message: 'first' });
            trail.add({ category: 'b', message: 'second' });
            trail.add({ category: 'c', message: 'third' });

            const messages = trail.list().map(b => b.message);

            expect(messages).toStrictEqual(['first', 'second', 'third']);
        });

        it('defaults to Date.now', () => {
            const before = Date.now();
            const trail = new BreadcrumbTrail();

            trail.add({ category: 'x', message: 'y' });

            const after = Date.now();
            const ts = trail.list()[0]?.timestamp ?? -1;

            expect(ts).toBeGreaterThanOrEqual(before);
            expect(ts).toBeLessThanOrEqual(after);
        });
    });

    describe('capacity eviction', () => {
        it('retains up to the configured capacity without eviction', () => {
            const trail = new BreadcrumbTrail(3, () => 0);

            trail.add({ category: 'a', message: '1' });
            trail.add({ category: 'a', message: '2' });
            trail.add({ category: 'a', message: '3' });

            expect(trail.list()).toHaveLength(3);
        });

        it('evicts the oldest entry when capacity is exceeded', () => {
            const trail = new BreadcrumbTrail(3, () => 0);

            trail.add({ category: 'a', message: 'first' });
            trail.add({ category: 'a', message: 'second' });
            trail.add({ category: 'a', message: 'third' });
            trail.add({ category: 'a', message: 'fourth' });

            const messages = trail.list().map(b => b.message);

            expect(messages).toStrictEqual(['second', 'third', 'fourth']);
        });

        it('keeps only the last N entries after many additions', () => {
            const trail = new BreadcrumbTrail(2, () => 0);

            for (let i = 1; i <= 5; i++) {
                trail.add({ category: 'x', message: String(i) });
            }

            const messages = trail.list().map(b => b.message);

            expect(messages).toStrictEqual(['4', '5']);
        });

        it('defaults to a capacity of 50', () => {
            const trail = new BreadcrumbTrail(undefined, () => 0);

            for (let i = 0; i < 51; i++) {
                trail.add({ category: 'x', message: String(i) });
            }

            expect(trail.list()).toHaveLength(50);
            expect(trail.list()[0]?.message).toBe('1');
        });
    });

    describe('clear', () => {
        it('empties the trail', () => {
            const trail = new BreadcrumbTrail(50, () => 0);

            trail.add({ category: 'a', message: 'x' });
            trail.clear();

            expect(trail.list()).toStrictEqual([]);
        });

        it('accepts new entries after clear', () => {
            const trail = new BreadcrumbTrail(50, () => 0);

            trail.add({ category: 'a', message: 'old' });
            trail.clear();
            trail.add({ category: 'b', message: 'new' });

            expect(trail.list()).toHaveLength(1);
            expect(trail.list()[0]?.message).toBe('new');
        });
    });

    describe('list', () => {
        it('returns a snapshot unaffected by later adds', () => {
            const trail = new BreadcrumbTrail(50, () => 0);

            trail.add({ category: 'a', message: 'first' });
            const snapshot = trail.list();

            trail.add({ category: 'b', message: 'second' });

            expect(snapshot).toHaveLength(1);
        });
    });
});
