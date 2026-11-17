/**
 * Unit tests for the list-filter factory namespace.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import { ApiQuery } from './api-query';
import type { FilterScalar } from './filter-expression';
import { filter } from './list-filter';
import { QueryError } from './query-error';

/**
 * Parse the `filters` parameter of a query back to an object.
 *
 * @returns the decoded filter tree, or an empty object when none is set
 */
function parsedFilters(query: ApiQuery): unknown {
    const params = query.toQueryParameters();

    if (params['filters'] === undefined) {
        return {};
    }

    return JSON.parse(String(params['filters']));
}

/**
 * Build a wire-style object from entry tuples, keeping `$`-prefixed keys out of
 * object-literal key positions.
 */
function wire(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
    return Object.fromEntries(entries);
}

describe('filter', () => {
    describe('equals', () => {
        it.each([
            ['a string', 'status', 'active'],
            ['a numeric', 'age', 30],
            ['a true', 'active', true],
            ['a false', 'active', false],
        ])('applies %s equality filter', (_label, field, value) => {
            const q = filter.equals(field).apply(ApiQuery.create(), value);

            expect(parsedFilters(q)).toEqual({ [field]: value });
        });

        it('nests a single-segment dot path', () => {
            const q = filter.equals('posts.published').apply(ApiQuery.create(), true);

            expect(parsedFilters(q)).toEqual({ posts: { published: true } });
        });

        it('nests a two-segment dot path', () => {
            const q = filter.equals('posts.author.name').apply(ApiQuery.create(), 'Alice');

            expect(parsedFilters(q)).toEqual({ posts: { author: { name: 'Alice' } } });
        });
    });

    describe('anyOf', () => {
        it('applies a $in filter', () => {
            const q = filter.anyOf('status').apply(ApiQuery.create(), ['active', 'pending']);

            expect(parsedFilters(q)).toEqual(wire([['status', wire([['$in', ['active', 'pending']]])]]));
        });

        it('applies a $in filter via a dot path', () => {
            const q = filter.anyOf('posts.status').apply(ApiQuery.create(), ['draft', 'published']);

            expect(parsedFilters(q)).toEqual({ posts: wire([['status', wire([['$in', ['draft', 'published']]])]]) });
        });

        it('takes only a list of scalars', () => {
            const anyOf = filter.anyOf('role');

            expectTypeOf(anyOf.apply).parameter(1).toEqualTypeOf<readonly FilterScalar[]>();
            expectTypeOf((query: ApiQuery) => {
                // @ts-expect-error -- a single scalar is not a list
                return anyOf.apply(query, 'x');
            }).toBeFunction();
        });

        it('applies no filter for an empty list', () => {
            const base = ApiQuery.create().where('status', 'active');
            const q = filter.anyOf('posts.status').apply(base, []);

            expect(q.toQueryParameters()).toEqual({ filters: '{"status":"active"}' });
        });
    });

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

    describe('atLeast', () => {
        it('applies a $ge filter', () => {
            const q = filter.atLeast('age').apply(ApiQuery.create(), 18);

            expect(parsedFilters(q)).toEqual(wire([['age', wire([['$ge', 18]])]]));
        });

        it('applies a $ge filter via a dot path', () => {
            const q = filter.atLeast('order.total').apply(ApiQuery.create(), 50);

            expect(parsedFilters(q)).toEqual({ order: wire([['total', wire([['$ge', 50]])]]) });
        });

        it('refuses an infinite bound', () => {
            expect(() => filter.atLeast('order.total').apply(ApiQuery.create(), Number.POSITIVE_INFINITY)).toThrow(
                new QueryError('The "total" filter needs finite numbers.'),
            );
        });
    });

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

    describe('boolean', () => {
        it('applies a true filter', () => {
            const q = filter.boolean('verified').apply(ApiQuery.create(), true);

            expect(parsedFilters(q)).toEqual({ verified: true });
        });

        it('applies a false filter', () => {
            const q = filter.boolean('verified').apply(ApiQuery.create(), false);

            expect(parsedFilters(q)).toEqual({ verified: false });
        });

        it('applies a false filter via a dot path', () => {
            const q = filter.boolean('user.active').apply(ApiQuery.create(), false);

            expect(parsedFilters(q)).toEqual({ user: { active: false } });
        });
    });

    describe('present', () => {
        it('applies $notNull for true', () => {
            const q = filter.present('deletedAt').apply(ApiQuery.create(), true);

            expect(parsedFilters(q)).toEqual(wire([['deletedAt', wire([['$notNull', true]])]]));
        });

        it('applies $null for false', () => {
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

    describe('search', () => {
        it('sets the top-level search parameter', () => {
            const q = filter.search().apply(ApiQuery.create(), 'alice');

            expect(q.toQueryString()).toBe('search=alice');
        });

        it('clears the search for an empty term', () => {
            const base = ApiQuery.create().search('alice');

            expect(filter.search().apply(base, '').toQueryParameters()).toEqual({});
        });
    });

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

    describe('filter namespace', () => {
        it('is frozen', () => {
            expect(Object.isFrozen(filter)).toBe(true);
        });
    });
});
