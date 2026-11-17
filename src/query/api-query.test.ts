/**
 * Unit tests for ApiQuery.
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
 */
function filtersParam(query: ApiQuery): unknown {
    return query.toQueryParameters()['filters'];
}

/**
 * Build a wire-style object from entry tuples, keeping `$`-prefixed keys out of
 * object-literal key positions.
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

    describe('where (equality)', () => {
        it.each([
            ['string', 'name', 'Alice'],
            ['number', 'age', 30],
            ['boolean', 'active', true],
        ])('emits a %s equality filter', (_type, field, value) => {
            expect(parsedFilters(ApiQuery.create().where(field, value))).toEqual({ [field]: value });
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

    describe('where (operator overload)', () => {
        it.each([
            ['$eq', 'name', 'Alice'],
            ['$neq', 'name', 'Bob'],
            ['$gt', 'age', 18],
            ['$lt', 'age', 65],
            ['$ge', 'age', 18],
            ['$le', 'age', 65],
        ] as const)('emits the %s operator', (operator, field, value) => {
            const result = parsedFilters(ApiQuery.create().where(field, operator, value));

            expect(result).toEqual(wire([[field, wire([[operator, value]])]]));
        });
    });

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

    describe('whereRelation', () => {
        it('nests a sub-query document under the relation key', () => {
            const query = ApiQuery.create().whereRelation('posts', q => q.where('title', 'News'));

            expect(filtersParam(query)).toBe('{"posts":{"title":"News"}}');
        });

        it('nests multiple conditions in one relation document', () => {
            const query = ApiQuery.create().whereRelation('posts', q =>
                q.where('published', true).where('views', '$gt', 100),
            );

            expect(filtersParam(query)).toBe('{"posts":{"published":true,"views":{"$gt":100}}}');
        });

        it('merges repeated calls into one relation document', () => {
            const query = ApiQuery.create()
                .whereRelation('author', q => q.where('first_name', 'Ada'))
                .whereRelation('author', q => q.where('last_name', 'Lovelace'));

            expect(filtersParam(query)).toBe('{"author":{"first_name":"Ada","last_name":"Lovelace"}}');
        });

        it('replaces a scalar stored under the relation key', () => {
            const query = ApiQuery.create()
                .where('author', 'stray')
                .whereRelation('author', q => q.where('name', 'Alice'));

            expect(filtersParam(query)).toBe('{"author":{"name":"Alice"}}');
        });

        it('merges repeated calls on a nested relation', () => {
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

        it('replaces an array operand on a relation field', () => {
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

        it('ANDs a second $or on the relation beside the first', () => {
            const query = ApiQuery.create()
                .whereRelation('posts', p => p.orWhere([q => q.where('a', 1), q => q.where('b', 2)]))
                .whereRelation('posts', p => p.orWhere([q => q.where('c', 3), q => q.where('d', 4)]));

            expect(filtersParam(query)).toBe('{"posts":{"$or":[{"a":1},{"b":2}],"$and":[{"$or":[{"c":3},{"d":4}]}]}}');
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

        it('replaces a non-list $and on the relation with the incoming documents', () => {
            const query = ApiQuery.create()
                .whereRelation('posts', p => p.where('$and', 'stray'))
                .whereRelation('posts', p => p.andWhere([q => q.where('b', 2)]));

            expect(filtersParam(query)).toBe('{"posts":{"$and":[{"b":2}]}}');
        });

        it('replaces a non-list $or on the relation with the incoming group', () => {
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

        it('ANDs a second conditioned $hasnt inside the relation document, not the root', () => {
            const query = ApiQuery.create()
                .andWhere([q => q.where('a', 1)])
                .whereRelation('author', a => a.whereHasNot('posts', p => p.where('spam', true)))
                .whereRelation('author', a => a.whereHasNot('posts', p => p.where('x', 1)));

            expect(filtersParam(query)).toBe(
                '{"$and":[{"a":1}],"author":{"$hasnt":{"posts":{"spam":true}},"$and":[{"$hasnt":{"posts":{"x":1}}}]}}',
            );
        });

        it('ANDs a second conditioned $hasnt inside a $has relation document', () => {
            const query = ApiQuery.create()
                .whereHas('author', a => a.whereHasNot('posts', p => p.where('spam', true)))
                .whereHas('author', a => a.whereHasNot('posts', p => p.where('flagged', true)));

            expect(filtersParam(query)).toBe(
                '{"$has":{"author":{"$hasnt":{"posts":{"spam":true}},"$and":[{"$hasnt":{"posts":{"flagged":true}}}]}}}',
            );
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

        it('treats a build with no conditions as bare', () => {
            const query = ApiQuery.create()
                .whereHas('posts', q => q)
                .whereHas('comments');

            expect(filtersParam(query)).toBe('{"$has":["posts","comments"]}');
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

        it('does not repeat a bare relation refused twice', () => {
            const query = ApiQuery.create().whereHasNot('posts').whereHasNot('posts');

            expect(filtersParam(query)).toBe('{"$hasnt":["posts"]}');
        });

        it('ANDs a second conditioned document on one relation beside the first', () => {
            const query = ApiQuery.create()
                .whereHasNot('posts', q => q.where('spam', true))
                .whereHasNot('posts', q => q.where('flagged', true));

            expect(filtersParam(query)).toBe(
                '{"$hasnt":{"posts":{"spam":true}},"$and":[{"$hasnt":{"posts":{"flagged":true}}}]}',
            );
        });

        it('appends a colliding conditioned document to an existing $and group', () => {
            const query = ApiQuery.create()
                .andWhere([q => q.where('status', 'active')])
                .whereHasNot('posts', q => q.where('spam', true))
                .whereHasNot('posts', q => q.where('flagged', true));

            expect(filtersParam(query)).toBe(
                '{"$and":[{"status":"active"},{"$hasnt":{"posts":{"flagged":true}}}],"$hasnt":{"posts":{"spam":true}}}',
            );
        });

        it('lets a bare relation absorb a later conditioned one', () => {
            const query = ApiQuery.create()
                .whereHasNot('posts')
                .whereHasNot('posts', q => q.where('spam', true));

            expect(filtersParam(query)).toBe('{"$hasnt":["posts"]}');
        });

        it('lets a bare relation absorb an earlier conditioned one', () => {
            const query = ApiQuery.create()
                .whereHasNot('comments', q => q.where('approved', false))
                .whereHasNot('posts', q => q.where('spam', true))
                .whereHasNot('posts');

            expect(filtersParam(query)).toBe('{"$hasnt":{"comments":{"approved":false},"posts":{}}}');
        });

        it('lets a bare relation absorb conditioned documents already separated into $and', () => {
            const query = ApiQuery.create()
                .whereHasNot('posts', q => q.where('spam', true))
                .whereHasNot('posts', q => q.where('flagged', true))
                .whereHasNot('posts');

            expect(filtersParam(query)).toBe('{"$hasnt":["posts"]}');
        });

        it('keeps the other $and documents when a bare relation absorbs a separated one', () => {
            const query = ApiQuery.create()
                .andWhere([q => q.where('status', 'active').whereHasNot('posts', p => p.where('draft', true))])
                .whereHasNot('posts', q => q.where('spam', true))
                .whereHasNot('posts', q => q.where('flagged', true))
                .whereHasNot('comments', q => q.where('approved', false))
                .whereHasNot('comments', q => q.where('hidden', true))
                .whereHasNot('posts');

            expect(filtersParam(query)).toBe(
                '{"$and":[{"status":"active","$hasnt":{"posts":{"draft":true}}},{"$hasnt":{"comments":{"hidden":true}}}],"$hasnt":{"posts":{},"comments":{"approved":false}}}',
            );
        });

        it('keeps an $and document that also refuses a relation the bare one leaves conditioned', () => {
            const query = ApiQuery.create()
                .andWhere([
                    q => q.whereHasNot('posts', p => p.where('spam', true)).whereHasNot('tags', t => t.where('x', 1)),
                ])
                .whereHasNot('posts');

            expect(filtersParam(query)).toBe(
                '{"$and":[{"$hasnt":{"posts":{"spam":true},"tags":{"x":1}}}],"$hasnt":["posts"]}',
            );
        });

        it('keeps separated documents when another conditioned one arrives', () => {
            const query = ApiQuery.create()
                .whereHasNot('posts', q => q.where('spam', true))
                .whereHasNot('posts', q => q.where('flagged', true))
                .whereHasNot('posts', q => q.where('draft', true));

            expect(filtersParam(query)).toBe(
                '{"$hasnt":{"posts":{"spam":true}},"$and":[{"$hasnt":{"posts":{"flagged":true}}},{"$hasnt":{"posts":{"draft":true}}}]}',
            );
        });

        it('leaves a malformed $and alone when the merge changes nothing', () => {
            const query = ApiQuery.create().where('$and', 'stray').whereHasNot('posts');

            expect(filtersParam(query)).toBe('{"$and":"stray","$hasnt":["posts"]}');
        });

        it('lets a nested bare relation absorb documents separated into the relation document', () => {
            const query = ApiQuery.create()
                .andWhere([q => q.where('a', 1)])
                .whereRelation('author', a => a.whereHasNot('posts', p => p.where('spam', true)))
                .whereRelation('author', a => a.whereHasNot('posts', p => p.where('x', 1)))
                .whereRelation('author', a => a.whereHasNot('posts'));

            expect(filtersParam(query)).toBe('{"$and":[{"a":1}],"author":{"$hasnt":["posts"]}}');
        });

        it('treats a build with no conditions as bare', () => {
            const query = ApiQuery.create()
                .whereHasNot('posts', q => q.where('spam', true))
                .whereHasNot('posts', q => q);

            expect(filtersParam(query)).toBe('{"$hasnt":["posts"]}');
        });

        it('keeps $has and $hasnt apart', () => {
            const query = ApiQuery.create().whereHas('posts').whereHasNot('comments');

            expect(filtersParam(query)).toBe('{"$has":["posts"],"$hasnt":["comments"]}');
        });
    });

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
            expect(() => ApiQuery.create().orWhere([])).toThrow(
                new QueryError('A $or group needs at least one document.'),
            );
        });

        it('rejects a document with no conditions', () => {
            expect(() => ApiQuery.create().orWhere([q => q])).toThrow(
                new QueryError('Every $or document needs at least one condition.'),
            );
        });
    });

    describe('search', () => {
        it('emits a top-level search parameter', () => {
            expect(ApiQuery.create().search('smith').toQueryString()).toBe('search=smith');
        });

        it('trims the term', () => {
            expect(ApiQuery.create().search('  ada lovelace  ').toQueryParameters()).toEqual({
                search: 'ada lovelace',
            });
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

        it('emits search as its own parameter beside the filters', () => {
            const query = ApiQuery.create().where('status', 'active').search('smith');

            expect(query.toQueryParameters()).toEqual({ filters: '{"status":"active"}', search: 'smith' });
        });
    });

    describe('filterTree', () => {
        it('returns an empty object for a fresh query', () => {
            expect(ApiQuery.create().filterTree()).toEqual({});
        });

        it('returns the assembled filter tree', () => {
            const tree = ApiQuery.create().where('name', 'Alice').filterTree();

            expect(tree).toEqual({ name: 'Alice' });
        });
    });

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

        it('drops the cursor token but stays cursor-paginated', () => {
            const query = ApiQuery.create().useCursorPagination().cursor('tok').orderBy('name');

            expect(query.toQueryParameters()).toEqual({ order: 'name', pagination: 'cursor' });
        });

        it('keeps a query paginated by a cursor token alone cursor-paginated', () => {
            const query = ApiQuery.create().cursor('tok').orderBy('name');

            expect(query.toQueryParameters()).toEqual({ order: 'name', pagination: 'cursor' });
        });

        it('leaves an offset-paginated query offset-paginated', () => {
            const query = ApiQuery.create().page(2).orderBy('name');

            expect(query.toQueryParameters()).toEqual({ order: 'name', page: 2 });
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

        it('refuses random order on a query paginated by a cursor token', () => {
            expect(() => ApiQuery.create().cursor('tok').orderByRandom()).toThrow(
                new QueryError('Random order cannot be combined with cursor pagination.'),
            );
        });

        it('refuses random order under forced cursor pagination', () => {
            expect(() => ApiQuery.create().useCursorPagination().orderByRandom()).toThrow(
                new QueryError('Random order cannot be combined with cursor pagination.'),
            );
        });
    });

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

        it('emits aggregates beside a field list that requests them', () => {
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

    describe('toQueryString', () => {
        it('returns an empty string for an empty query', () => {
            expect(ApiQuery.create().toQueryString()).toBe('');
        });

        it('round-trips an equality filter through URLSearchParams', () => {
            const query = ApiQuery.create().where('name', 'Alice');
            const qs = query.toQueryString();
            const parsed = new URLSearchParams(qs);

            expect(JSON.parse(parsed.get('filters') ?? '')).toEqual({ name: 'Alice' });
        });

        it('round-trips bracket keys through URLSearchParams', () => {
            const query = ApiQuery.create().fieldsFor('users', ['name', 'email']);
            const qs = query.toQueryString();
            const parsed = new URLSearchParams(qs);

            expect(parsed.get('fields[users]')).toBe('name,email');
        });

        it('round-trips an operator map through URLSearchParams', () => {
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

        it('encodes page and limit as strings', () => {
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
