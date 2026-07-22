/**
 * Unit tests for the list-filter factory namespace.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { ApiQuery } from './api-query';
import { filter } from './list-filter';

// ---------------------------------------------------------------------------
// Helper: parse the `filters` parameter back to an object
// ---------------------------------------------------------------------------
function parsedFilters(query: ApiQuery): unknown {
    const params = query.toQueryParameters();

    if (params['filters'] === undefined) {
        return {};
    }

    return JSON.parse(String(params['filters']));
}

// ---------------------------------------------------------------------------
// Helper: build wire-style objects from entry tuples (keeps $-prefixed keys out
// of object-literal key positions where Biome might inspect them).
// ---------------------------------------------------------------------------
function wire(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
    return Object.fromEntries(entries);
}

describe('filter', () => {
    // -------------------------------------------------------------------------
    // filter.equals
    // -------------------------------------------------------------------------
    describe('equals', () => {
        it('applies a string equality filter', () => {
            const q = filter.equals('status').apply(ApiQuery.create(), 'active');

            expect(parsedFilters(q)).toEqual({ status: 'active' });
        });

        it('applies a numeric equality filter', () => {
            const q = filter.equals('age').apply(ApiQuery.create(), 30);

            expect(parsedFilters(q)).toEqual({ age: 30 });
        });

        it('applies a boolean equality filter (true)', () => {
            const q = filter.equals('active').apply(ApiQuery.create(), true);

            expect(parsedFilters(q)).toEqual({ active: true });
        });

        it('applies a boolean equality filter (false)', () => {
            const q = filter.equals('active').apply(ApiQuery.create(), false);

            expect(parsedFilters(q)).toEqual({ active: false });
        });

        it('nests a single-segment dot path', () => {
            const q = filter.equals('posts.published').apply(ApiQuery.create(), true);

            expect(parsedFilters(q)).toEqual({ posts: { published: true } });
        });

        it('nests a two-segment dot path (posts.author.name)', () => {
            const q = filter.equals('posts.author.name').apply(ApiQuery.create(), 'Alice');

            expect(parsedFilters(q)).toEqual({ posts: { author: { name: 'Alice' } } });
        });
    });

    // -------------------------------------------------------------------------
    // filter.text
    // -------------------------------------------------------------------------
    describe('text', () => {
        it('applies a $like filter on a plain field', () => {
            const q = filter.text('name').apply(ApiQuery.create(), 'ali');

            expect(parsedFilters(q)).toEqual(wire([['name', wire([['$like', 'ali']])]]));
        });

        it('applies a $like filter on a dot-path field', () => {
            const q = filter.text('posts.title').apply(ApiQuery.create(), 'news');

            expect(parsedFilters(q)).toEqual({ posts: wire([['title', wire([['$like', 'news']])]]) });
        });
    });

    // -------------------------------------------------------------------------
    // filter.anyOf
    // -------------------------------------------------------------------------
    describe('anyOf', () => {
        it('applies a $in filter', () => {
            const q = filter.anyOf('status').apply(ApiQuery.create(), ['active', 'pending']);

            expect(parsedFilters(q)).toEqual(wire([['status', wire([['$in', ['active', 'pending']]])]]));
        });

        it('applies a $in filter via a dot path', () => {
            const q = filter.anyOf('posts.status').apply(ApiQuery.create(), ['draft', 'published']);

            expect(parsedFilters(q)).toEqual({ posts: wire([['status', wire([['$in', ['draft', 'published']]])]]) });
        });
    });

    // -------------------------------------------------------------------------
    // filter.between
    // -------------------------------------------------------------------------
    describe('between', () => {
        it('applies a $between filter with numeric bounds', () => {
            const q = filter.between('age').apply(ApiQuery.create(), [18, 65]);

            expect(parsedFilters(q)).toEqual(wire([['age', wire([['$between', [18, 65]]])]]));
        });

        it('applies a $between filter via a dot path', () => {
            const q = filter.between('order.amount').apply(ApiQuery.create(), [100, 500]);

            expect(parsedFilters(q)).toEqual({ order: wire([['amount', wire([['$between', [100, 500]]])]]) });
        });
    });

    // -------------------------------------------------------------------------
    // filter.atLeast
    // -------------------------------------------------------------------------
    describe('atLeast', () => {
        it('applies a $ge filter', () => {
            const q = filter.atLeast('age').apply(ApiQuery.create(), 18);

            expect(parsedFilters(q)).toEqual(wire([['age', wire([['$ge', 18]])]]));
        });

        it('applies a $ge filter via a dot path', () => {
            const q = filter.atLeast('order.total').apply(ApiQuery.create(), 50);

            expect(parsedFilters(q)).toEqual({ order: wire([['total', wire([['$ge', 50]])]]) });
        });
    });

    // -------------------------------------------------------------------------
    // filter.atMost
    // -------------------------------------------------------------------------
    describe('atMost', () => {
        it('applies a $le filter', () => {
            const q = filter.atMost('age').apply(ApiQuery.create(), 65);

            expect(parsedFilters(q)).toEqual(wire([['age', wire([['$le', 65]])]]));
        });

        it('applies a $le filter via a dot path', () => {
            const q = filter.atMost('order.total').apply(ApiQuery.create(), 200);

            expect(parsedFilters(q)).toEqual({ order: wire([['total', wire([['$le', 200]])]]) });
        });
    });

    // -------------------------------------------------------------------------
    // filter.boolean
    // -------------------------------------------------------------------------
    describe('boolean', () => {
        it('applies a boolean true filter', () => {
            const q = filter.boolean('verified').apply(ApiQuery.create(), true);

            expect(parsedFilters(q)).toEqual({ verified: true });
        });

        it('applies a boolean false filter (false is a real value, not a clear)', () => {
            const q = filter.boolean('verified').apply(ApiQuery.create(), false);

            expect(parsedFilters(q)).toEqual({ verified: false });
        });

        it('applies boolean false via a dot path', () => {
            const q = filter.boolean('user.active').apply(ApiQuery.create(), false);

            expect(parsedFilters(q)).toEqual({ user: { active: false } });
        });
    });

    // -------------------------------------------------------------------------
    // filter.present
    // -------------------------------------------------------------------------
    describe('present', () => {
        it('applies $notNull when value is true', () => {
            const q = filter.present('deletedAt').apply(ApiQuery.create(), true);

            expect(parsedFilters(q)).toEqual(wire([['deletedAt', wire([['$notNull', true]])]]));
        });

        it('applies $null when value is false', () => {
            const q = filter.present('deletedAt').apply(ApiQuery.create(), false);

            expect(parsedFilters(q)).toEqual(wire([['deletedAt', wire([['$null', true]])]]));
        });

        it('applies $notNull via a dot path', () => {
            const q = filter.present('user.verifiedAt').apply(ApiQuery.create(), true);

            expect(parsedFilters(q)).toEqual({ user: wire([['verifiedAt', wire([['$notNull', true]])]]) });
        });

        it('applies $null via a dot path', () => {
            const q = filter.present('user.verifiedAt').apply(ApiQuery.create(), false);

            expect(parsedFilters(q)).toEqual({ user: wire([['verifiedAt', wire([['$null', true]])]]) });
        });
    });

    // -------------------------------------------------------------------------
    // filter.contains
    // -------------------------------------------------------------------------
    describe('contains', () => {
        it('applies a $contains filter with a scalar value', () => {
            const q = filter.contains('tags').apply(ApiQuery.create(), 'news');

            expect(parsedFilters(q)).toEqual(wire([['tags', wire([['$contains', 'news']])]]));
        });

        it('applies a $contains filter with an array value', () => {
            const q = filter.contains('tags').apply(ApiQuery.create(), ['news', 'sport']);

            expect(parsedFilters(q)).toEqual(wire([['tags', wire([['$contains', ['news', 'sport']]])]]));
        });

        it('applies a $contains filter via a dot path', () => {
            const q = filter.contains('post.tags').apply(ApiQuery.create(), 'featured');

            expect(parsedFilters(q)).toEqual({ post: wire([['tags', wire([['$contains', 'featured']])]]) });
        });
    });

    // -------------------------------------------------------------------------
    // filter.searchAcross
    // -------------------------------------------------------------------------
    describe('searchAcross', () => {
        it('emits an $or group with a $like per plain field', () => {
            const q = filter.searchAcross(['name', 'email']).apply(ApiQuery.create(), 'alice');

            expect(parsedFilters(q)).toEqual(
                wire([
                    [
                        '$or',
                        wire([
                            ['name', wire([['$like', 'alice']])],
                            ['email', wire([['$like', 'alice']])],
                        ]),
                    ],
                ]),
            );
        });

        it('nests dot-path fields inside the $or group', () => {
            const q = filter.searchAcross(['name', 'posts.title']).apply(ApiQuery.create(), 'news');

            expect(parsedFilters(q)).toEqual(
                wire([
                    [
                        '$or',
                        wire([
                            ['name', wire([['$like', 'news']])],
                            ['posts', wire([['title', wire([['$like', 'news']])]])],
                        ]),
                    ],
                ]),
            );
        });

        it('handles a mix of plain and deeply-nested dot-path fields', () => {
            const q = filter.searchAcross(['title', 'posts.author.name']).apply(ApiQuery.create(), 'bob');

            expect(parsedFilters(q)).toEqual(
                wire([
                    [
                        '$or',
                        wire([
                            ['title', wire([['$like', 'bob']])],
                            ['posts', { author: wire([['name', wire([['$like', 'bob']])]]) }],
                        ]),
                    ],
                ]),
            );
        });

        it('works with a single field', () => {
            const q = filter.searchAcross(['email']).apply(ApiQuery.create(), 'test');

            expect(parsedFilters(q)).toEqual(wire([['$or', wire([['email', wire([['$like', 'test']])]])]]));
        });
    });

    // -------------------------------------------------------------------------
    // filter.custom
    // -------------------------------------------------------------------------
    describe('custom', () => {
        it('delegates to the provided apply function', () => {
            const myFilter = filter.custom<number>((query, value) => query.where('priority', '$ge', value));
            const q = myFilter.apply(ApiQuery.create(), 5);

            expect(parsedFilters(q)).toEqual(wire([['priority', wire([['$ge', 5]])]]));
        });

        it('passes the original query to the apply function', () => {
            const myFilter = filter.custom<string>((query, value) => query.where('category', value));
            const base = ApiQuery.create().where('status', 'active');
            const q = myFilter.apply(base, 'news');

            expect(parsedFilters(q)).toEqual({ status: 'active', category: 'news' });
        });
    });

    // -------------------------------------------------------------------------
    // filter object is frozen
    // -------------------------------------------------------------------------
    describe('filter namespace', () => {
        it('is frozen (prevents accidental mutation)', () => {
            expect(Object.isFrozen(filter)).toBe(true);
        });
    });
});
