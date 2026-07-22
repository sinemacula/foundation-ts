/**
 * Unit tests for ApiQuery - the laravel-api-toolkit 2.x query builder.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { ApiQuery } from './api-query';

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
// Helper: build wire-style objects from entry tuples (mirrors the wire() idiom
// used in other tests in this repo - keeps $-prefixed keys out of
// object-literal key positions in test assertions where Biome might inspect
// them).
// ---------------------------------------------------------------------------
function wire(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
    return Object.fromEntries(entries);
}

describe('ApiQuery', () => {
    describe('create', () => {
        it('returns an empty query with no parameters', () => {
            const params = ApiQuery.create().toQueryParameters();

            expect(params).toEqual({});
        });
    });

    // -------------------------------------------------------------------------
    // Filtering - equality
    // -------------------------------------------------------------------------
    describe('where (equality)', () => {
        it('emits a string equality filter', () => {
            const result = parsedFilters(ApiQuery.create().where('name', 'Alice'));

            expect(result).toEqual({ name: 'Alice' });
        });

        it('emits a number equality filter', () => {
            const result = parsedFilters(ApiQuery.create().where('age', 30));

            expect(result).toEqual({ age: 30 });
        });

        it('emits a boolean equality filter', () => {
            const result = parsedFilters(ApiQuery.create().where('active', true));

            expect(result).toEqual({ active: true });
        });

        it('replaces an existing operator map with a scalar equality value', () => {
            const base = ApiQuery.create().where('age', '$ge', 18);
            const result = parsedFilters(base.where('age', 30));

            expect(result).toEqual({ age: 30 });
        });
    });

    // -------------------------------------------------------------------------
    // Filtering - operator overload
    // -------------------------------------------------------------------------
    describe('where (operator overload)', () => {
        it('emits $eq operator', () => {
            const result = parsedFilters(ApiQuery.create().where('name', '$eq', 'Alice'));

            expect(result).toEqual(wire([['name', wire([['$eq', 'Alice']])]]));
        });

        it('emits $neq operator', () => {
            const result = parsedFilters(ApiQuery.create().where('name', '$neq', 'Bob'));

            expect(result).toEqual(wire([['name', wire([['$neq', 'Bob']])]]));
        });

        it('emits $gt operator', () => {
            const result = parsedFilters(ApiQuery.create().where('age', '$gt', 18));

            expect(result).toEqual(wire([['age', wire([['$gt', 18]])]]));
        });

        it('emits $lt operator', () => {
            const result = parsedFilters(ApiQuery.create().where('age', '$lt', 65));

            expect(result).toEqual(wire([['age', wire([['$lt', 65]])]]));
        });

        it('emits $ge operator', () => {
            const result = parsedFilters(ApiQuery.create().where('age', '$ge', 18));

            expect(result).toEqual(wire([['age', wire([['$ge', 18]])]]));
        });

        it('emits $le operator', () => {
            const result = parsedFilters(ApiQuery.create().where('age', '$le', 65));

            expect(result).toEqual(wire([['age', wire([['$le', 65]])]]));
        });

        it('emits $like operator', () => {
            const result = parsedFilters(ApiQuery.create().where('name', '$like', 'ali'));

            expect(result).toEqual(wire([['name', wire([['$like', 'ali']])]]));
        });
    });

    // -------------------------------------------------------------------------
    // Operator merge on one field
    // -------------------------------------------------------------------------
    describe('operator merge', () => {
        it('merges $ge and $le into a single object for the same field', () => {
            const result = parsedFilters(ApiQuery.create().where('age', '$ge', 18).where('age', '$le', 65));

            expect(result).toEqual(
                wire([
                    [
                        'age',
                        wire([
                            ['$ge', 18],
                            ['$le', 65],
                        ]),
                    ],
                ]),
            );
        });

        it('replaces an existing scalar equality with an operator map', () => {
            const base = ApiQuery.create().where('age', 30);
            const result = parsedFilters(base.where('age', '$ge', 18));

            expect(result).toEqual(wire([['age', wire([['$ge', 18]])]]));
        });

        it('leaves unrelated fields untouched when merging operators', () => {
            const result = parsedFilters(
                ApiQuery.create().where('name', 'Alice').where('age', '$ge', 18).where('age', '$le', 65),
            );

            expect(result).toEqual(
                wire([
                    ['name', 'Alice'],
                    [
                        'age',
                        wire([
                            ['$ge', 18],
                            ['$le', 65],
                        ]),
                    ],
                ]),
            );
        });
    });

    // -------------------------------------------------------------------------
    // whereIn
    // -------------------------------------------------------------------------
    describe('whereIn', () => {
        it('emits a $in filter', () => {
            const result = parsedFilters(ApiQuery.create().whereIn('status', ['active', 'pending']));

            expect(result).toEqual(wire([['status', wire([['$in', ['active', 'pending']]])]]));
        });

        it('accepts numeric values', () => {
            const result = parsedFilters(ApiQuery.create().whereIn('code', [1, 2, 3]));

            expect(result).toEqual(wire([['code', wire([['$in', [1, 2, 3]]])]]));
        });

        it('merges with existing operators on the same field', () => {
            const result = parsedFilters(
                ApiQuery.create().where('status', '$neq', 'archived').whereIn('status', ['active', 'pending']),
            );

            expect(result).toEqual(
                wire([
                    [
                        'status',
                        wire([
                            ['$neq', 'archived'],
                            ['$in', ['active', 'pending']],
                        ]),
                    ],
                ]),
            );
        });
    });

    // -------------------------------------------------------------------------
    // whereBetween
    // -------------------------------------------------------------------------
    describe('whereBetween', () => {
        it('emits a $between filter with a numeric pair', () => {
            const result = parsedFilters(ApiQuery.create().whereBetween('age', [18, 65]));

            expect(result).toEqual(wire([['age', wire([['$between', [18, 65]]])]]));
        });

        it('emits a $between filter with string bounds', () => {
            const result = parsedFilters(ApiQuery.create().whereBetween('date', ['2024-01-01', '2024-12-31']));

            expect(result).toEqual(wire([['date', wire([['$between', ['2024-01-01', '2024-12-31']]])]]));
        });
    });

    // -------------------------------------------------------------------------
    // whereContains
    // -------------------------------------------------------------------------
    describe('whereContains', () => {
        it('emits a $contains filter with a scalar value', () => {
            const result = parsedFilters(ApiQuery.create().whereContains('tags', 'news'));

            expect(result).toEqual(wire([['tags', wire([['$contains', 'news']])]]));
        });

        it('emits a $contains filter with an array value', () => {
            const result = parsedFilters(ApiQuery.create().whereContains('tags', ['news', 'sport']));

            expect(result).toEqual(wire([['tags', wire([['$contains', ['news', 'sport']]])]]));
        });
    });

    // -------------------------------------------------------------------------
    // whereNull / whereNotNull
    // -------------------------------------------------------------------------
    describe('whereNull', () => {
        it('emits a $null: true filter', () => {
            const result = parsedFilters(ApiQuery.create().whereNull('deletedAt'));

            expect(result).toEqual(wire([['deletedAt', wire([['$null', true]])]]));
        });
    });

    describe('whereNotNull', () => {
        it('emits a $notNull: true filter', () => {
            const result = parsedFilters(ApiQuery.create().whereNotNull('verifiedAt'));

            expect(result).toEqual(wire([['verifiedAt', wire([['$notNull', true]])]]));
        });
    });

    // -------------------------------------------------------------------------
    // Immutability
    // -------------------------------------------------------------------------
    describe('immutability', () => {
        it('does not mutate the parent instance when deriving a new query', () => {
            const base = ApiQuery.create().where('name', 'Alice');
            const derived = base.where('age', '$ge', 18);

            expect(parsedFilters(base)).toEqual({ name: 'Alice' });
            expect(parsedFilters(derived)).toEqual(
                wire([
                    ['name', 'Alice'],
                    ['age', wire([['$ge', 18]])],
                ]),
            );
        });

        it('does not mutate state when chaining multiple calls', () => {
            const q1 = ApiQuery.create();
            const q2 = q1.where('a', 1);
            const q3 = q2.where('b', 2);

            expect(parsedFilters(q1)).toEqual({});
            expect(parsedFilters(q2)).toEqual({ a: 1 });
            expect(parsedFilters(q3)).toEqual({ a: 1, b: 2 });
        });
    });

    // -------------------------------------------------------------------------
    // Relation filters
    // -------------------------------------------------------------------------
    describe('whereRelation', () => {
        it('nests a sub-query filter under the relation key', () => {
            const result = parsedFilters(
                ApiQuery.create().whereRelation('posts', q => q.where('title', '$like', 'news')),
            );

            expect(result).toEqual(wire([['posts', wire([['title', wire([['$like', 'news']])]])]]));
        });

        it('nests multiple filters on the relation', () => {
            const result = parsedFilters(
                ApiQuery.create().whereRelation('posts', q => q.where('published', true).where('views', '$gt', 100)),
            );

            expect(result).toEqual(
                wire([
                    [
                        'posts',
                        wire([
                            ['published', true],
                            ['views', wire([['$gt', 100]])],
                        ]),
                    ],
                ]),
            );
        });
    });

    // -------------------------------------------------------------------------
    // $has / $hasnt
    // -------------------------------------------------------------------------
    describe('whereHas', () => {
        it('emits the bare array form with a single relation', () => {
            const result = parsedFilters(ApiQuery.create().whereHas('posts'));

            expect(result).toEqual(wire([['$has', ['posts']]]));
        });

        it('emits the bare array form with multiple relations', () => {
            const result = parsedFilters(ApiQuery.create().whereHas('posts').whereHas('comments'));

            expect(result).toEqual(wire([['$has', ['posts', 'comments']]]));
        });

        it('emits the named form when a build callback is provided', () => {
            const result = parsedFilters(ApiQuery.create().whereHas('posts', q => q.where('published', true)));

            expect(result).toEqual(wire([['$has', wire([['posts', wire([['published', true]])]])]]));
        });

        it('promotes bare relations to object form with {} when a conditioned relation is added', () => {
            const result = parsedFilters(
                ApiQuery.create()
                    .whereHas('comments')
                    .whereHas('posts', q => q.where('published', true)),
            );

            expect(result).toEqual(
                wire([
                    [
                        '$has',
                        wire([
                            ['comments', {}],
                            ['posts', wire([['published', true]])],
                        ]),
                    ],
                ]),
            );
        });

        it('appends bare relations in the object form with {} after a conditioned entry', () => {
            const result = parsedFilters(
                ApiQuery.create()
                    .whereHas('posts', q => q.where('published', true))
                    .whereHas('comments'),
            );

            expect(result).toEqual(
                wire([
                    [
                        '$has',
                        wire([
                            ['posts', wire([['published', true]])],
                            ['comments', {}],
                        ]),
                    ],
                ]),
            );
        });

        it('merges multiple conditioned relations into one object', () => {
            const result = parsedFilters(
                ApiQuery.create()
                    .whereHas('posts', q => q.where('published', true))
                    .whereHas('comments', q => q.where('approved', true)),
            );

            expect(result).toEqual(
                wire([
                    [
                        '$has',
                        wire([
                            ['posts', wire([['published', true]])],
                            ['comments', wire([['approved', true]])],
                        ]),
                    ],
                ]),
            );
        });
    });

    describe('whereHasNot', () => {
        it('emits the bare array form for $hasnt', () => {
            const result = parsedFilters(ApiQuery.create().whereHasNot('posts'));

            expect(result).toEqual(wire([['$hasnt', ['posts']]]));
        });

        it('emits the named form for $hasnt', () => {
            const result = parsedFilters(ApiQuery.create().whereHasNot('posts', q => q.where('spam', true)));

            expect(result).toEqual(wire([['$hasnt', wire([['posts', wire([['spam', true]])]])]]));
        });

        it('promotes bare $hasnt relations to object form when conditioned entry is added', () => {
            const result = parsedFilters(
                ApiQuery.create()
                    .whereHasNot('comments')
                    .whereHasNot('posts', q => q.where('spam', true)),
            );

            expect(result).toEqual(
                wire([
                    [
                        '$hasnt',
                        wire([
                            ['comments', {}],
                            ['posts', wire([['spam', true]])],
                        ]),
                    ],
                ]),
            );
        });
    });

    // -------------------------------------------------------------------------
    // $and / $or groups
    // -------------------------------------------------------------------------
    describe('andWhere', () => {
        it('emits an $and group', () => {
            const result = parsedFilters(
                ApiQuery.create().andWhere(q => q.where('status', 'active').where('role', 'admin')),
            );

            expect(result).toEqual(
                wire([
                    [
                        '$and',
                        wire([
                            ['status', 'active'],
                            ['role', 'admin'],
                        ]),
                    ],
                ]),
            );
        });

        it('merges repeated andWhere calls into a single $and object', () => {
            const result = parsedFilters(
                ApiQuery.create()
                    .andWhere(q => q.where('status', 'active'))
                    .andWhere(q => q.where('role', 'admin')),
            );

            expect(result).toEqual(
                wire([
                    [
                        '$and',
                        wire([
                            ['status', 'active'],
                            ['role', 'admin'],
                        ]),
                    ],
                ]),
            );
        });
    });

    describe('orWhere', () => {
        it('emits an $or group', () => {
            const result = parsedFilters(
                ApiQuery.create().orWhere(q => q.where('status', 'active').where('role', 'admin')),
            );

            expect(result).toEqual(
                wire([
                    [
                        '$or',
                        wire([
                            ['status', 'active'],
                            ['role', 'admin'],
                        ]),
                    ],
                ]),
            );
        });

        it('merges repeated orWhere calls into a single $or object', () => {
            const result = parsedFilters(
                ApiQuery.create()
                    .orWhere(q => q.where('name', '$like', 'alice'))
                    .orWhere(q => q.where('email', '$like', 'alice')),
            );

            expect(result).toEqual(
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
    });

    // -------------------------------------------------------------------------
    // filterTree()
    // -------------------------------------------------------------------------
    describe('filterTree', () => {
        it('returns an empty object for a fresh query', () => {
            expect(ApiQuery.create().filterTree()).toEqual({});
        });

        it('returns the assembled filter tree', () => {
            const tree = ApiQuery.create().where('name', 'Alice').filterTree();

            expect(tree).toEqual({ name: 'Alice' });
        });
    });

    // -------------------------------------------------------------------------
    // Order serialisation
    // -------------------------------------------------------------------------
    describe('orderBy', () => {
        it('emits a single column with implicit asc direction', () => {
            const params = ApiQuery.create().orderBy('name').toQueryParameters();

            expect(params['order']).toBe('name');
        });

        it('emits a single column with explicit asc direction', () => {
            const params = ApiQuery.create().orderBy('name', 'asc').toQueryParameters();

            expect(params['order']).toBe('name');
        });

        it('emits a single column with explicit desc direction', () => {
            const params = ApiQuery.create().orderBy('name', 'desc').toQueryParameters();

            expect(params['order']).toBe('name:desc');
        });

        it('emits multiple columns as a comma-separated list', () => {
            const params = ApiQuery.create()
                .orderBy('lastName', 'asc')
                .orderBy('firstName', 'desc')
                .toQueryParameters();

            expect(params['order']).toBe('lastName,firstName:desc');
        });

        it('replaces a column already in the list and appends it at the end', () => {
            const params = ApiQuery.create()
                .orderBy('name', 'asc')
                .orderBy('age', 'desc')
                .orderBy('name', 'desc')
                .toQueryParameters();

            expect(params['order']).toBe('age:desc,name:desc');
        });
    });

    describe('orderByRandom', () => {
        it('emits "random" in the order list', () => {
            const params = ApiQuery.create().orderByRandom().toQueryParameters();

            expect(params['order']).toBe('random');
        });

        it('appends random after other order entries', () => {
            const params = ApiQuery.create().orderBy('name').orderByRandom().toQueryParameters();

            expect(params['order']).toBe('name,random');
        });
    });

    // -------------------------------------------------------------------------
    // Pagination
    // -------------------------------------------------------------------------
    describe('page', () => {
        it('emits the page number', () => {
            const params = ApiQuery.create().page(3).toQueryParameters();

            expect(params['page']).toBe(3);
        });
    });

    describe('limit', () => {
        it('emits the limit', () => {
            const params = ApiQuery.create().limit(25).toQueryParameters();

            expect(params['limit']).toBe(25);
        });
    });

    describe('cursor', () => {
        it('emits the cursor token', () => {
            const params = ApiQuery.create().cursor('abc123').toQueryParameters();

            expect(params['cursor']).toBe('abc123');
        });
    });

    describe('useCursorPagination', () => {
        it('emits pagination=cursor', () => {
            const params = ApiQuery.create().useCursorPagination().toQueryParameters();

            expect(params['pagination']).toBe('cursor');
        });

        it('does not emit pagination=cursor when not called', () => {
            const params = ApiQuery.create().toQueryParameters();

            expect(params['pagination']).toBeUndefined();
        });
    });

    describe('pagination combination', () => {
        it('emits page, limit, cursor, and pagination together', () => {
            const params = ApiQuery.create().page(1).limit(20).cursor('tok').useCursorPagination().toQueryParameters();

            expect(params['page']).toBe(1);
            expect(params['limit']).toBe(20);
            expect(params['cursor']).toBe('tok');
            expect(params['pagination']).toBe('cursor');
        });
    });

    // -------------------------------------------------------------------------
    // Sparse fields
    // -------------------------------------------------------------------------
    describe('fields', () => {
        it('emits a comma-joined global fields parameter', () => {
            const params = ApiQuery.create().fields(['name', 'email']).toQueryParameters();

            expect(params['fields']).toBe('name,email');
        });
    });

    describe('fieldsFor', () => {
        it('emits a per-resource bracket key', () => {
            const params = ApiQuery.create().fieldsFor('users', ['name', 'email']).toQueryParameters();

            expect(params['fields[users]']).toBe('name,email');
        });

        it('emits multiple per-resource bracket keys', () => {
            const params = ApiQuery.create()
                .fieldsFor('users', ['name', 'email'])
                .fieldsFor('posts', ['title', 'body'])
                .toQueryParameters();

            expect(params['fields[users]']).toBe('name,email');
            expect(params['fields[posts]']).toBe('title,body');
        });
    });

    // -------------------------------------------------------------------------
    // Counts
    // -------------------------------------------------------------------------
    describe('counts', () => {
        it('emits a comma-joined global counts parameter', () => {
            const params = ApiQuery.create().counts(['posts', 'comments']).toQueryParameters();

            expect(params['counts']).toBe('posts,comments');
        });
    });

    describe('countsFor', () => {
        it('emits a per-resource bracket key for counts', () => {
            const params = ApiQuery.create().countsFor('users', ['posts', 'comments']).toQueryParameters();

            expect(params['counts[users]']).toBe('posts,comments');
        });
    });

    // -------------------------------------------------------------------------
    // Aggregates: sums / averages
    // -------------------------------------------------------------------------
    describe('sumFor', () => {
        it('emits a double-bracket key for sums', () => {
            const params = ApiQuery.create().sumFor('account', 'transaction', ['amount', 'fee']).toQueryParameters();

            expect(params['sums[account][transaction]']).toBe('amount,fee');
        });

        it('emits multiple sums entries', () => {
            const params = ApiQuery.create()
                .sumFor('account', 'transaction', ['amount', 'fee'])
                .sumFor('account', 'refund', ['amount'])
                .toQueryParameters();

            expect(params['sums[account][transaction]']).toBe('amount,fee');
            expect(params['sums[account][refund]']).toBe('amount');
        });
    });

    describe('averageFor', () => {
        it('emits a double-bracket key for averages', () => {
            const params = ApiQuery.create().averageFor('account', 'transaction', ['amount']).toQueryParameters();

            expect(params['averages[account][transaction]']).toBe('amount');
        });
    });

    // -------------------------------------------------------------------------
    // Empty query → {} parameters
    // -------------------------------------------------------------------------
    describe('empty query', () => {
        it('produces an empty QueryParameters object', () => {
            expect(ApiQuery.create().toQueryParameters()).toEqual({});
        });

        it('does not emit a filters key when no filters are set', () => {
            const params = ApiQuery.create().toQueryParameters();

            expect(params['filters']).toBeUndefined();
        });

        it('does not emit an order key when no ordering is set', () => {
            const params = ApiQuery.create().toQueryParameters();

            expect(params['order']).toBeUndefined();
        });
    });

    // -------------------------------------------------------------------------
    // toQueryString
    // -------------------------------------------------------------------------
    describe('toQueryString', () => {
        it('returns an empty string for an empty query', () => {
            expect(ApiQuery.create().toQueryString()).toBe('');
        });

        it('encodes a simple equality filter and survives a URLSearchParams round-trip', () => {
            const query = ApiQuery.create().where('name', 'Alice');
            const qs = query.toQueryString();
            const parsed = new URLSearchParams(qs);

            expect(JSON.parse(parsed.get('filters') ?? '')).toEqual({ name: 'Alice' });
        });

        it('encodes bracket keys correctly so they survive a URLSearchParams round-trip', () => {
            const query = ApiQuery.create().fieldsFor('users', ['name', 'email']);
            const qs = query.toQueryString();
            const parsed = new URLSearchParams(qs);

            expect(parsed.get('fields[users]')).toBe('name,email');
        });

        it('encodes a complex JSON filter string that survives a URLSearchParams round-trip', () => {
            const query = ApiQuery.create().where('age', '$ge', 18).where('age', '$le', 65);
            const qs = query.toQueryString();
            const parsed = new URLSearchParams(qs);
            const filters = JSON.parse(parsed.get('filters') ?? '');

            expect(filters).toEqual(
                wire([
                    [
                        'age',
                        wire([
                            ['$ge', 18],
                            ['$le', 65],
                        ]),
                    ],
                ]),
            );
        });

        it('encodes page and limit as strings in the query string', () => {
            const qs = ApiQuery.create().page(2).limit(25).toQueryString();
            const parsed = new URLSearchParams(qs);

            expect(parsed.get('page')).toBe('2');
            expect(parsed.get('limit')).toBe('25');
        });
    });
});
