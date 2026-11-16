/**
 * Unit tests for ApiQuery - the laravel-api-toolkit 2.x query builder.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { ApiQuery } from './api-query';
import { QueryError } from './query-error';

/**
 * Parse the `filters` parameter of a query back to an object.
 *
 * @param query - the query to read
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
 * Read the raw `filters` parameter of a query, exactly as sent on the wire.
 *
 * @param query - the query to read
 * @returns the JSON-encoded filter tree
 */
function filtersParam(query: ApiQuery): unknown {
    return query.toQueryParameters()['filters'];
}

/**
 * Build a wire-style object from entry tuples, keeping `$`-prefixed keys out of
 * object-literal key positions.
 *
 * @param entries - key-value pairs for the record
 * @returns a plain record
 */
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

        it('replaces an existing scalar equality value with an operator map', () => {
            const base = ApiQuery.create().where('status', 'draft');

            expect(filtersParam(base.where('status', '$neq', 'archived'))).toBe('{"status":{"$neq":"archived"}}');
        });

        it('emits falsy scalars as real equality conditions', () => {
            const query = ApiQuery.create().where('name', '').where('count', 0).where('active', false);

            expect(filtersParam(query)).toBe('{"name":"","count":0,"active":false}');
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
        it('nests a sub-query document under the relation key', () => {
            const query = ApiQuery.create().whereRelation('posts', q => q.where('title', 'News'));

            expect(filtersParam(query)).toBe('{"posts":{"title":"News"}}');
        });

        it('nests multiple conditions in one relation document', () => {
            const query = ApiQuery.create().whereRelation('posts', q => q.where('published', true).where('views', '$gt', 100));

            expect(filtersParam(query)).toBe('{"posts":{"published":true,"views":{"$gt":100}}}');
        });

        it('merges repeated calls into one document so the same related row must match', () => {
            const query = ApiQuery.create()
                .whereRelation('author', q => q.where('first_name', 'Ada'))
                .whereRelation('author', q => q.where('last_name', 'Lovelace'));

            expect(filtersParam(query)).toBe('{"author":{"first_name":"Ada","last_name":"Lovelace"}}');
        });

        it('replaces a scalar collision on the relation key rather than merging into it', () => {
            const query = ApiQuery.create()
                .where('author', 'stray')
                .whereRelation('author', q => q.where('name', 'Alice'));

            expect(filtersParam(query)).toBe('{"author":{"name":"Alice"}}');
        });

        it('merges repeated calls that target the same nested relation at any depth', () => {
            const query = ApiQuery.create()
                .whereRelation('posts', p => p.whereRelation('author', a => a.where('first_name', 'x')))
                .whereRelation('posts', p => p.whereRelation('author', a => a.where('last_name', 'y')));

            expect(filtersParam(query)).toBe('{"posts":{"author":{"first_name":"x","last_name":"y"}}}');
        });

        it('merges operator maps on the same relation field across separate calls', () => {
            const query = ApiQuery.create()
                .whereRelation('author', a => a.where('age', '$ge', 18))
                .whereRelation('author', a => a.where('age', '$le', 65));

            expect(filtersParam(query)).toBe('{"author":{"age":{"$ge":18,"$le":65}}}');
        });

        it('replaces an earlier operator map on a relation field with a later scalar', () => {
            const query = ApiQuery.create()
                .whereRelation('author', a => a.where('bio', '$neq', 'x'))
                .whereRelation('author', a => a.where('bio', 'exact'));

            expect(filtersParam(query)).toBe('{"author":{"bio":"exact"}}');
        });

        it('replaces an array operand on a relation field rather than concatenating it', () => {
            const query = ApiQuery.create()
                .whereRelation('author', a => a.whereIn('role', ['admin']))
                .whereRelation('author', a => a.whereIn('role', ['editor']));

            expect(filtersParam(query)).toBe('{"author":{"role":{"$in":["editor"]}}}');
        });

        it('keeps a single $or inside a relation document as built', () => {
            const query = ApiQuery.create().whereRelation('posts', p =>
                p.orWhere([q => q.where('title', 'test'), q => q.where('id', 1)]).where('id', 7),
            );

            expect(filtersParam(query)).toBe('{"posts":{"$or":[{"title":"test"},{"id":1}],"id":7}}');
        });

        it('ANDs a second $or on the same relation beside the first instead of merging the groups', () => {
            const query = ApiQuery.create()
                .whereRelation('posts', p => p.orWhere([q => q.where('a', 1), q => q.where('b', 2)]))
                .whereRelation('posts', p => p.orWhere([q => q.where('c', 3), q => q.where('d', 4)]));

            expect(filtersParam(query)).toBe(
                '{"posts":{"$or":[{"a":1},{"b":2}],"$and":[{"$or":[{"c":3},{"d":4}]}]}}',
            );
        });

        it('appends a later $or to an $and the relation document already carries', () => {
            const query = ApiQuery.create()
                .whereRelation('posts', p =>
                    p.andWhere([q => q.where('x', 0)]).orWhere([q => q.where('a', 1), q => q.where('b', 2)]),
                )
                .whereRelation('posts', p => p.orWhere([q => q.where('c', 3), q => q.where('d', 4)]));

            expect(filtersParam(query)).toBe(
                '{"posts":{"$and":[{"x":0},{"$or":[{"c":3},{"d":4}]}],"$or":[{"a":1},{"b":2}]}}',
            );
        });

        it('concatenates $and documents on the same relation', () => {
            const query = ApiQuery.create()
                .whereRelation('posts', p => p.andWhere([q => q.where('a', 1)]))
                .whereRelation('posts', p => p.andWhere([q => q.where('b', 2)]));

            expect(filtersParam(query)).toBe('{"posts":{"$and":[{"a":1},{"b":2}]}}');
        });

        it('takes an incoming $and when the relation key holds a non-list value', () => {
            const query = ApiQuery.create()
                .whereRelation('posts', p => p.where('$and', 'stray'))
                .whereRelation('posts', p => p.andWhere([q => q.where('b', 2)]));

            expect(filtersParam(query)).toBe('{"posts":{"$and":[{"b":2}]}}');
        });

        it('keeps a second relation $or as its own group when the first was stored as a non-list', () => {
            const query = ApiQuery.create()
                .whereRelation('posts', p => p.where('$or', 'stray'))
                .whereRelation('posts', p => p.orWhere([q => q.where('c', 3)]));

            expect(filtersParam(query)).toBe('{"posts":{"$or":[{"c":3}]}}');
        });

        it('keeps nested bare $has lists in list form when merged', () => {
            const query = ApiQuery.create()
                .whereRelation('author', a => a.whereHas('posts'))
                .whereRelation('author', a => a.whereHas('comments'));

            expect(filtersParam(query)).toBe('{"author":{"$has":["posts","comments"]}}');
        });

        it('promotes a nested $has list to the map form when a conditioned relation merges in', () => {
            const query = ApiQuery.create()
                .whereRelation('author', a => a.whereHas('posts'))
                .whereRelation('author', a => a.whereHas('comments', c => c.where('approved', true)));

            expect(filtersParam(query)).toBe('{"author":{"$has":{"posts":{},"comments":{"approved":true}}}}');
        });

        it('merges nested $hasnt documents on the same relation', () => {
            const query = ApiQuery.create()
                .whereRelation('author', a => a.whereHasNot('posts', p => p.where('spam', true)))
                .whereRelation('author', a => a.whereHasNot('posts', p => p.where('flagged', true)));

            expect(filtersParam(query)).toBe('{"author":{"$hasnt":{"posts":{"spam":true,"flagged":true}}}}');
        });

        it('merges nested bare $hasnt lists', () => {
            const query = ApiQuery.create()
                .whereRelation('author', a => a.whereHasNot('posts'))
                .whereRelation('author', a => a.whereHasNot('comments'));

            expect(filtersParam(query)).toBe('{"author":{"$hasnt":["posts","comments"]}}');
        });

        it('replaces a malformed nested $has value with the incoming relation list', () => {
            const query = ApiQuery.create()
                .whereRelation('author', a => a.where('$has', 'stray'))
                .whereRelation('author', a => a.whereHas('posts'));

            expect(filtersParam(query)).toBe('{"author":{"$has":["posts"]}}');
        });
    });

    // -------------------------------------------------------------------------
    // $has / $hasnt
    // -------------------------------------------------------------------------
    describe('whereHas', () => {
        it('emits the bare list form with a single relation', () => {
            expect(filtersParam(ApiQuery.create().whereHas('posts'))).toBe('{"$has":["posts"]}');
        });

        it('emits the bare list form with multiple relations', () => {
            const query = ApiQuery.create().whereHas('posts').whereHas('comments');

            expect(filtersParam(query)).toBe('{"$has":["posts","comments"]}');
        });

        it('does not repeat a bare relation asserted twice', () => {
            const query = ApiQuery.create().whereHas('posts').whereHas('posts');

            expect(filtersParam(query)).toBe('{"$has":["posts"]}');
        });

        it('emits the map form when a build callback is provided', () => {
            const query = ApiQuery.create().whereHas('posts', q => q.where('published', true));

            expect(filtersParam(query)).toBe('{"$has":{"posts":{"published":true}}}');
        });

        it('promotes bare relations to the map form with {} when a conditioned relation is added', () => {
            const query = ApiQuery.create()
                .whereHas('comments')
                .whereHas('posts', q => q.where('published', true));

            expect(filtersParam(query)).toBe('{"$has":{"comments":{},"posts":{"published":true}}}');
        });

        it('appends bare relations in the map form with {} after a conditioned entry', () => {
            const query = ApiQuery.create()
                .whereHas('posts', q => q.where('published', true))
                .whereHas('comments');

            expect(filtersParam(query)).toBe('{"$has":{"posts":{"published":true},"comments":{}}}');
        });

        it('keeps the conditions when the same relation is asserted bare afterwards', () => {
            const query = ApiQuery.create()
                .whereHas('posts', q => q.where('published', true))
                .whereHas('posts');

            expect(filtersParam(query)).toBe('{"$has":{"posts":{"published":true}}}');
        });

        it('adds conditions to a relation first asserted bare', () => {
            const query = ApiQuery.create()
                .whereHas('posts')
                .whereHas('posts', q => q.where('published', true));

            expect(filtersParam(query)).toBe('{"$has":{"posts":{"published":true}}}');
        });

        it('merges multiple conditioned relations into one map', () => {
            const query = ApiQuery.create()
                .whereHas('posts', q => q.where('published', true))
                .whereHas('comments', q => q.where('approved', true));

            expect(filtersParam(query)).toBe('{"$has":{"posts":{"published":true},"comments":{"approved":true}}}');
        });

        it('merges conditions when the same relation is asserted twice', () => {
            const query = ApiQuery.create()
                .whereHas('posts', q => q.where('published', true))
                .whereHas('posts', q => q.where('featured', true));

            expect(filtersParam(query)).toBe('{"$has":{"posts":{"published":true,"featured":true}}}');
        });
    });

    describe('whereHasNot', () => {
        it('emits the bare list form for $hasnt', () => {
            expect(filtersParam(ApiQuery.create().whereHasNot('posts'))).toBe('{"$hasnt":["posts"]}');
        });

        it('emits the map form for $hasnt', () => {
            const query = ApiQuery.create().whereHasNot('posts', q => q.where('spam', true));

            expect(filtersParam(query)).toBe('{"$hasnt":{"posts":{"spam":true}}}');
        });

        it('promotes bare $hasnt relations to the map form when a conditioned entry is added', () => {
            const query = ApiQuery.create()
                .whereHasNot('comments')
                .whereHasNot('posts', q => q.where('spam', true));

            expect(filtersParam(query)).toBe('{"$hasnt":{"comments":{},"posts":{"spam":true}}}');
        });

        it('merges conditions when the same relation is refused twice', () => {
            const query = ApiQuery.create()
                .whereHasNot('posts', q => q.where('spam', true))
                .whereHasNot('posts', q => q.where('flagged', true));

            expect(filtersParam(query)).toBe('{"$hasnt":{"posts":{"spam":true,"flagged":true}}}');
        });

        it('keeps $has and $hasnt apart', () => {
            const query = ApiQuery.create().whereHas('posts').whereHasNot('comments');

            expect(filtersParam(query)).toBe('{"$has":["posts"],"$hasnt":["comments"]}');
        });
    });

    // -------------------------------------------------------------------------
    // $and / $or groups
    // -------------------------------------------------------------------------
    describe('andWhere', () => {
        it('emits an $and group with one document per builder', () => {
            const query = ApiQuery.create().andWhere([
                q => q.whereRelation('posts', p => p.where('a', 1)),
                q => q.whereRelation('posts', p => p.where('b', 2)),
            ]);

            expect(filtersParam(query)).toBe('{"$and":[{"posts":{"a":1}},{"posts":{"b":2}}]}');
        });

        it('ANDs the keys inside one document', () => {
            const query = ApiQuery.create().andWhere([q => q.where('status', 'active').where('role', 'admin')]);

            expect(filtersParam(query)).toBe('{"$and":[{"status":"active","role":"admin"}]}');
        });

        it('appends repeated calls to the same group', () => {
            const query = ApiQuery.create()
                .andWhere([q => q.where('status', 'active')])
                .andWhere([q => q.where('role', 'admin')]);

            expect(filtersParam(query)).toBe('{"$and":[{"status":"active"},{"role":"admin"}]}');
        });

        it('nests $or groups as whole documents', () => {
            const query = ApiQuery.create().andWhere([
                q => q.orWhere([a => a.where('a', 1), b => b.where('b', 2)]),
                q => q.orWhere([c => c.where('c', 3), d => d.where('d', 4)]),
            ]);

            expect(filtersParam(query)).toBe('{"$and":[{"$or":[{"a":1},{"b":2}]},{"$or":[{"c":3},{"d":4}]}]}');
        });

        it('replaces a scalar collision on the group key', () => {
            const query = ApiQuery.create()
                .where('$and', 'stray')
                .andWhere([q => q.where('status', 'active')]);

            expect(filtersParam(query)).toBe('{"$and":[{"status":"active"}]}');
        });

        it('rejects an empty group', () => {
            expect(() => ApiQuery.create().andWhere([])).toThrow(
                new QueryError('A $and group needs at least one document.'),
            );
        });

        it('rejects a document with no conditions', () => {
            expect(() => ApiQuery.create().andWhere([q => q.where('a', 1), q => q])).toThrow(
                new QueryError('Every $and document needs at least one condition.'),
            );
        });

        it('leaves the source query untouched', () => {
            const base = ApiQuery.create().andWhere([q => q.where('a', 1)]);

            base.andWhere([q => q.where('b', 2)]);

            expect(filtersParam(base)).toBe('{"$and":[{"a":1}]}');
        });
    });

    describe('orWhere', () => {
        it('emits (a AND b) OR c from one document per builder', () => {
            const query = ApiQuery.create().orWhere([
                q => q.where('role', 'admin').where('status', 'active'),
                q => q.where('role', 'owner'),
            ]);

            expect(filtersParam(query)).toBe('{"$or":[{"role":"admin","status":"active"},{"role":"owner"}]}');
        });

        it('ANDs the group with sibling root conditions', () => {
            const query = ApiQuery.create()
                .where('status', 'active')
                .orWhere([q => q.where('name', 'a'), q => q.where('email', 'b')]);

            expect(filtersParam(query)).toBe('{"status":"active","$or":[{"name":"a"},{"email":"b"}]}');
        });

        it('appends repeated calls as further branches of the same group', () => {
            const query = ApiQuery.create()
                .orWhere([q => q.where('name', 'alice')])
                .orWhere([q => q.where('email', 'alice@example.com')]);

            expect(filtersParam(query)).toBe('{"$or":[{"name":"alice"},{"email":"alice@example.com"}]}');
        });

        it('keeps a relation document as one branch', () => {
            const query = ApiQuery.create().orWhere([
                q => q.where('name', 'a'),
                q => q.whereRelation('posts', p => p.whereRelation('user', u => u.where('name', 'b'))),
            ]);

            expect(filtersParam(query)).toBe('{"$or":[{"name":"a"},{"posts":{"user":{"name":"b"}}}]}');
        });

        it('rejects an empty group', () => {
            expect(() => ApiQuery.create().orWhere([])).toThrow(new QueryError('A $or group needs at least one document.'));
        });

        it('rejects a document with no conditions', () => {
            expect(() => ApiQuery.create().orWhere([q => q])).toThrow(
                new QueryError('Every $or document needs at least one condition.'),
            );
        });
    });

    // -------------------------------------------------------------------------
    // Search
    // -------------------------------------------------------------------------
    describe('search', () => {
        it('emits a top-level search parameter', () => {
            expect(ApiQuery.create().search('smith').toQueryString()).toBe('search=smith');
        });

        it('trims the term', () => {
            expect(ApiQuery.create().search('  ada lovelace  ').toQueryParameters()).toEqual({ search: 'ada lovelace' });
        });

        it('replaces an earlier term', () => {
            expect(ApiQuery.create().search('ada').search('grace').toQueryParameters()).toEqual({ search: 'grace' });
        });

        it('clears the term when given an empty string', () => {
            expect(ApiQuery.create().search('ada').search('').toQueryParameters()).toEqual({});
        });

        it('clears the term when given only whitespace', () => {
            expect(ApiQuery.create().search('ada').search(' \t ').toQueryParameters()).toEqual({});
        });

        it('emits search beside the filters rather than inside them', () => {
            const query = ApiQuery.create().where('status', 'active').search('smith');

            expect(query.toQueryParameters()).toEqual({ filters: '{"status":"active"}', search: 'smith' });
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

        it('clears the cursor, which only seeks within the order it was issued for', () => {
            const query = ApiQuery.create().useCursorPagination().cursor('tok').orderBy('name');

            expect(query.toQueryParameters()).toEqual({ order: 'name', pagination: 'cursor' });
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

        it('does not repeat random when called twice', () => {
            const params = ApiQuery.create().orderByRandom().orderByRandom().toQueryParameters();

            expect(params['order']).toBe('random');
        });

        it('drops a cursor token and stays offset-paginated', () => {
            const query = ApiQuery.create().cursor('tok').orderByRandom();

            expect(query.toQueryParameters()).toEqual({ order: 'random' });
        });

        it('refuses random order under forced cursor pagination', () => {
            expect(() => ApiQuery.create().useCursorPagination().orderByRandom()).toThrow(
                new QueryError('Random order cannot be combined with cursor pagination.'),
            );
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

        it('keeps a non-random order', () => {
            const query = ApiQuery.create().orderBy('id').cursor('abc123');

            expect(query.toQueryParameters()).toEqual({ order: 'id', cursor: 'abc123' });
        });

        it('refuses a cursor under random order', () => {
            expect(() => ApiQuery.create().orderByRandom().cursor('abc123')).toThrow(
                new QueryError('Random order cannot be combined with cursor pagination.'),
            );
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

        it('refuses cursor pagination under random order', () => {
            expect(() => ApiQuery.create().orderBy('name').orderByRandom().useCursorPagination()).toThrow(
                new QueryError('Random order cannot be combined with cursor pagination.'),
            );
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
    // Sparse fields and aggregates
    // -------------------------------------------------------------------------
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

    describe('aggregatesFor', () => {
        it('emits a per-resource aggregates bracket key', () => {
            const params = ApiQuery.create()
                .aggregatesFor('user', ['posts_count', 'orders_sum_total'])
                .toQueryParameters();

            expect(params).toEqual({ 'aggregates[user]': 'posts_count,orders_sum_total' });
        });

        it('replaces the keys of a type requested twice', () => {
            const params = ApiQuery.create()
                .aggregatesFor('user', ['posts_count'])
                .aggregatesFor('user', ['posts_exists'])
                .toQueryParameters();

            expect(params).toEqual({ 'aggregates[user]': 'posts_exists' });
        });

        it('emits the shape the toolkit renders, with aggregates in the field list', () => {
            const query = ApiQuery.create()
                .fieldsFor('user', ['name', 'aggregates'])
                .aggregatesFor('user', ['posts_count', 'orders_sum_total', 'last_order_at'])
                .aggregatesFor('post', ['comments_count']);

            expect(new URLSearchParams(query.toQueryString()).toString()).toBe(
                new URLSearchParams([
                    ['fields[user]', 'name,aggregates'],
                    ['aggregates[user]', 'posts_count,orders_sum_total,last_order_at'],
                    ['aggregates[post]', 'comments_count'],
                ]).toString(),
            );
        });
    });

    // -------------------------------------------------------------------------
    // Soft deletes
    // -------------------------------------------------------------------------
    describe('withTrashed', () => {
        it('emits trashed=with', () => {
            expect(ApiQuery.create().withTrashed().toQueryString()).toBe('trashed=with');
        });
    });

    describe('onlyTrashed', () => {
        it('emits trashed=only', () => {
            expect(ApiQuery.create().onlyTrashed().toQueryString()).toBe('trashed=only');
        });

        it('replaces an earlier visibility', () => {
            expect(ApiQuery.create().withTrashed().onlyTrashed().toQueryString()).toBe('trashed=only');
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

        it('emits every parameter in a stable order', () => {
            const query = ApiQuery.create()
                .onlyTrashed()
                .aggregatesFor('user', ['posts_count'])
                .fieldsFor('user', ['name', 'aggregates'])
                .useCursorPagination()
                .limit(10)
                .orderBy('name', 'desc')
                .search('ada')
                .orWhere([q => q.where('role', 'admin'), q => q.where('role', 'owner')]);

            expect(query.toQueryParameters()).toEqual({
                filters: '{"$or":[{"role":"admin"},{"role":"owner"}]}',
                search: 'ada',
                order: 'name:desc',
                limit: 10,
                pagination: 'cursor',
                'fields[user]': 'name,aggregates',
                'aggregates[user]': 'posts_count',
                trashed: 'only',
            });
            expect(Object.keys(query.toQueryParameters())).toEqual([
                'filters',
                'search',
                'order',
                'limit',
                'pagination',
                'fields[user]',
                'aggregates[user]',
                'trashed',
            ]);
        });
    });
});
