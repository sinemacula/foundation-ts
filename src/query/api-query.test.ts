/**
 * Unit tests for ApiQuery.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

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

/** The builder calls that take a field or relation name, keyed by method. */
const NAMED_CALLS: ReadonlyArray<readonly [string, (query: ApiQuery, name: string) => ApiQuery]> = [
    ['where', (q, name) => q.where(name, 1)],
    ['where with an operator', (q, name) => q.where(name, '$ge', 1)],
    ['whereIn', (q, name) => q.whereIn(name, [1])],
    ['whereBetween', (q, name) => q.whereBetween(name, [1, 2])],
    ['whereContains', (q, name) => q.whereContains(name, 'a')],
    ['whereNull', (q, name) => q.whereNull(name)],
    ['whereNotNull', (q, name) => q.whereNotNull(name)],
    ['whereRelation', (q, name) => q.whereRelation(name, r => r.where('a', 1))],
    ['whereHas', (q, name) => q.whereHas(name)],
    ['whereHasNot', (q, name) => q.whereHasNot(name, r => r.where('a', 1))],
];

/** The calls that change the rows a query selects. */
const ROW_SET_CALLS: ReadonlyArray<readonly [string, (query: ApiQuery) => ApiQuery]> = [
    ...NAMED_CALLS.map(([method, call]) => [method, (q: ApiQuery) => call(q, 'f')] as const),
    ['andWhere', q => q.andWhere([a => a.where('a', 1)])],
    ['orWhere', q => q.orWhere([a => a.where('a', 1)])],
    ['search', q => q.search('ada')],
    ['withTrashed', q => q.withTrashed()],
    ['onlyTrashed', q => q.onlyTrashed()],
];

/**
 * Build the filter calls that carry `n` as an operand on the field `n`.
 */
function nonFiniteCalls(n: number): ReadonlyArray<readonly [string, (query: ApiQuery) => ApiQuery]> {
    return [
        ['where', q => q.where('n', n)],
        ['where with an operator', q => q.where('n', '$gt', n)],
        ['whereIn', q => q.whereIn('n', [1, n])],
        ['whereBetween', q => q.whereBetween('n', [1, n])],
        ['whereContains with a scalar', q => q.whereContains('n', n)],
        ['whereContains with a list', q => q.whereContains('n', ['a', n])],
    ];
}

/**
 * Collect every object node of a filter tree, the root included.
 */
function treeNodes(node: unknown): unknown[] {
    if (typeof node !== 'object' || node === null) {
        return [];
    }

    return [node, ...Object.values(node).flatMap(treeNodes)];
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

        it('ANDs a scalar equality beside an operator map on the field', () => {
            const query = ApiQuery.create().where('age', '$ge', 18).where('age', 30);

            expect(filtersParam(query)).toBe('{"age":{"$ge":18},"$and":[{"age":30}]}');
        });

        it('ANDs an operator map beside a scalar equality on the field', () => {
            const query = ApiQuery.create().where('status', 'draft').where('status', '$neq', 'archived');

            expect(filtersParam(query)).toBe('{"status":"draft","$and":[{"status":{"$neq":"archived"}}]}');
        });

        it('ANDs a different equality beside the first', () => {
            const query = ApiQuery.create().where('status', 'published').where('status', 'draft');

            expect(filtersParam(query)).toBe('{"status":"published","$and":[{"status":"draft"}]}');
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

        it('ANDs an operator that collides with a different operand beside the map', () => {
            const query = ApiQuery.create().where('n', '$ge', 1).where('n', '$le', 9).where('n', '$ge', 5);

            expect(filtersParam(query)).toBe('{"n":{"$ge":1,"$le":9},"$and":[{"n":{"$ge":5}}]}');
        });

        it('ANDs a merged map beside an operator it collides with in part', () => {
            const query = ApiQuery.create()
                .whereRelation('a', q => q.where('n', '$ge', 5))
                .whereRelation('a', q => q.where('n', '$ge', 1).where('n', '$le', 9));

            expect(filtersParam(query)).toBe('{"a":{"n":{"$ge":5},"$and":[{"n":{"$ge":1,"$le":9}}]}}');
        });

        it.each([
            ['an equality', (q: ApiQuery) => q.where('k', 'a'), '{"k":"a"}'],
            ['an operator', (q: ApiQuery) => q.where('k', '$ge', 1), '{"k":{"$ge":1}}'],
            ['a $in list', (q: ApiQuery) => q.whereIn('k', [1, 2]), '{"k":{"$in":[1,2]}}'],
            ['a $between pair', (q: ApiQuery) => q.whereBetween('k', [1, 2]), '{"k":{"$between":[1,2]}}'],
            ['a $contains list', (q: ApiQuery) => q.whereContains('k', ['a']), '{"k":{"$contains":["a"]}}'],
            ['a $null check', (q: ApiQuery) => q.whereNull('k'), '{"k":{"$null":true}}'],
        ])('keeps %s repeated with the same operand once', (_label, apply, expected) => {
            expect(filtersParam(apply(apply(ApiQuery.create())))).toBe(expected);
        });

        it.each([
            ['a longer list', (q: ApiQuery) => q.whereIn('k', [1]), (q: ApiQuery) => q.whereIn('k', [1, 2])],
            ['a reordered list', (q: ApiQuery) => q.whereIn('k', [1, 2]), (q: ApiQuery) => q.whereIn('k', [2, 1])],
            [
                'a list differing in one item',
                (q: ApiQuery) => q.whereIn('k', [1, 2]),
                (q: ApiQuery) => q.whereIn('k', [1, 3]),
            ],
            ['a number then a string', (q: ApiQuery) => q.where('k', 1), (q: ApiQuery) => q.where('k', '1')],
            [
                'a list then a scalar',
                (q: ApiQuery) => q.whereContains('k', ['a']),
                (q: ApiQuery) => q.whereContains('k', 'a'),
            ],
            [
                'a scalar then a list',
                (q: ApiQuery) => q.whereContains('k', 'a'),
                (q: ApiQuery) => q.whereContains('k', ['a']),
            ],
        ])('ANDs %s beside the earlier condition', (_label, first, second) => {
            const earlier = first(ApiQuery.create()).filterTree();
            const later = second(ApiQuery.create()).filterTree();

            expect(second(first(ApiQuery.create())).filterTree()).toEqual(
                wire([...Object.entries(earlier), ['$and', [later]]]),
            );
        });

        it.each([
            ['$eq', (q: ApiQuery) => q.where('x', '$eq', 1)],
            ['$neq', (q: ApiQuery) => q.where('x', '$neq', 1)],
            ['$gt', (q: ApiQuery) => q.where('x', '$gt', 1)],
            ['$lt', (q: ApiQuery) => q.where('x', '$lt', 1)],
            ['$ge', (q: ApiQuery) => q.where('x', '$ge', 1)],
            ['$le', (q: ApiQuery) => q.where('x', '$le', 1)],
            ['$in', (q: ApiQuery) => q.whereIn('x', [1])],
            ['$between', (q: ApiQuery) => q.whereBetween('x', [1, 2])],
            ['$contains', (q: ApiQuery) => q.whereContains('x', 'a')],
            ['$null', (q: ApiQuery) => q.whereNull('x')],
            ['$notNull', (q: ApiQuery) => q.whereNotNull('x')],
        ])('keeps a %s map and a relation document on one key apart', (_operator, apply) => {
            const operator = apply(ApiQuery.create()).filterTree();
            const related = ApiQuery.create().whereRelation('x', r => r.where('y', 1));
            const relation = related.filterTree();

            expect(
                apply(ApiQuery.create())
                    .whereRelation('x', r => r.where('y', 1))
                    .filterTree(),
            ).toEqual(wire([...Object.entries(operator), ['$and', [relation]]]));
            expect(apply(related).filterTree()).toEqual(wire([...Object.entries(relation), ['$and', [operator]]]));
        });

        it('treats an empty document as a relation document, not an operator map', () => {
            const empty = ApiQuery.create().whereRelation('x', q => q);

            expect(filtersParam(empty.where('x', '$ge', 1))).toBe('{"x":{},"$and":[{"x":{"$ge":1}}]}');
            expect(filtersParam(empty.whereRelation('x', q => q.where('y', 1)))).toBe('{"x":{"y":1}}');
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

    describe('where (types)', () => {
        it('refuses a list operator in the operator form', () => {
            expectTypeOf((query: ApiQuery) => {
                // @ts-expect-error -- $in takes a list through whereIn
                return query.where('a', '$in', 1);
            }).toBeFunction();
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
        it.each([
            ['whereIn', (values: string[]) => ApiQuery.create().whereIn('k', values)],
            ['whereBetween', (values: string[]) => ApiQuery.create().whereBetween('k', values as [string, string])],
            ['whereContains', (values: string[]) => ApiQuery.create().whereContains('k', values)],
            ['fieldsFor', (values: string[]) => ApiQuery.create().fieldsFor('user', values)],
            ['aggregatesFor', (values: string[]) => ApiQuery.create().aggregatesFor('user', values)],
        ])('copies the array %s is given', (_method, build) => {
            const values = ['a', 'b'];
            const query = build(values);
            const before = query.toQueryParameters();

            values.push('c');
            values[0] = 'z';

            expect(query.toQueryParameters()).toStrictEqual(before);
            expect(Object.isFrozen(values)).toBe(false);
        });

        it('exposes a filter tree frozen at every depth', () => {
            const tree = ApiQuery.create()
                .whereIn('status', ['a', 'b'])
                .whereHas('posts', p => p.whereBetween('views', [1, 9]))
                .orWhere([q => q.where('a', 1), q => q.whereRelation('author', a => a.whereNull('bio'))])
                .filterTree();
            const nodes = treeNodes(tree);

            expect(nodes).toHaveLength(12);
            expect(nodes.every(node => Object.isFrozen(node))).toBe(true);
            expect(() => {
                (tree as Record<string, unknown>)['status'] = 'x';
            }).toThrow(TypeError);
        });

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

    describe('names', () => {
        it.each(
            ['$and', '$or', '$has', '$hasnt', '$ge'].flatMap(name =>
                NAMED_CALLS.map(([method, call]) => [method, name, call] as const),
            ),
        )('%s refuses the reserved name %s', (_method, name, call) => {
            expect(() => call(ApiQuery.create(), name)).toThrow(
                new QueryError(`"${name}" is not a field or relation name.`),
            );
        });

        it.each(['__proto__', 'constructor', 'toString'])('treats %s as a plain name', name => {
            const query = ApiQuery.create()
                .where('active', true)
                .where(name, 1)
                .where(name, 1)
                .whereRelation('author', a => a.whereRelation(name, r => r.where('id', 1)));

            expect(filtersParam(query)).toBe(`{"active":true,"${name}":1,"author":{"${name}":{"id":1}}}`);
        });
    });

    describe('finite numbers', () => {
        it.each(
            [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].flatMap(n =>
                nonFiniteCalls(n).map(([method, call]) => [method, n, call] as const),
            ),
        )('%s refuses %s', (_method, _n, call) => {
            expect(() => call(ApiQuery.create())).toThrow(new QueryError('The "n" filter needs finite numbers.'));
        });

        it('accepts finite numbers beside strings and booleans', () => {
            const query = ApiQuery.create().whereIn('n', [0, -1.5, 'a', true]);

            expect(filtersParam(query)).toBe('{"n":{"$in":[0,-1.5,"a",true]}}');
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

        it('ANDs a relation document beside a scalar stored under the key', () => {
            const query = ApiQuery.create()
                .where('author', 'stray')
                .whereRelation('author', q => q.where('name', 'Alice'));

            expect(filtersParam(query)).toBe('{"author":"stray","$and":[{"author":{"name":"Alice"}}]}');
        });

        it('ANDs a scalar beside a relation document stored under the key', () => {
            const query = ApiQuery.create()
                .whereRelation('author', q => q.where('name', 'Alice'))
                .where('author', 'stray');

            expect(filtersParam(query)).toBe('{"author":{"name":"Alice"},"$and":[{"author":"stray"}]}');
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

        it('ANDs a later scalar beside an operator map on a relation field', () => {
            const query = ApiQuery.create()
                .whereRelation('author', a => a.where('bio', '$neq', 'x'))
                .whereRelation('author', a => a.where('bio', 'exact'));

            expect(filtersParam(query)).toBe('{"author":{"bio":{"$neq":"x"},"$and":[{"bio":"exact"}]}}');
        });

        it('ANDs a different array operand beside the first on a relation field', () => {
            const query = ApiQuery.create()
                .whereRelation('author', a => a.whereIn('role', ['admin']))
                .whereRelation('author', a => a.whereIn('role', ['editor']));

            expect(filtersParam(query)).toBe(
                '{"author":{"role":{"$in":["admin"]},"$and":[{"role":{"$in":["editor"]}}]}}',
            );
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

        it('leaves the tree unchanged when a bare relation is refused again', () => {
            const query = ApiQuery.create()
                .andWhere([q => q.where('a', 1)])
                .whereHasNot('posts')
                .whereHasNot('posts');

            expect(filtersParam(query)).toBe('{"$and":[{"a":1}],"$hasnt":["posts"]}');
        });

        it.each([
            [
                'before',
                ApiQuery.create()
                    .whereHasNot('posts')
                    .andWhere([q => q.whereHasNot('posts', p => p.where('spam', true))]),
            ],
            [
                'after',
                ApiQuery.create()
                    .andWhere([q => q.whereHasNot('posts', p => p.where('spam', true))])
                    .whereHasNot('posts'),
            ],
        ])('drops a conditioned $and document a bare relation refused %s it implies', (_order, query) => {
            expect(filtersParam(query)).toBe('{"$hasnt":["posts"]}');
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

        it('ANDs a second call beside the earlier group rather than widening it', () => {
            const query = ApiQuery.create()
                .orWhere([q => q.where('owner', 1), q => q.where('shared', true)])
                .orWhere([q => q.where('status', 'draft'), q => q.where('status', 'review')]);

            expect(filtersParam(query)).toBe(
                '{"$or":[{"owner":1},{"shared":true}],"$and":[{"$or":[{"status":"draft"},{"status":"review"}]}]}',
            );
        });

        it('keeps a group repeated from the same branch queries once', () => {
            const owner = ApiQuery.create().where('owner', 1);
            const shared = ApiQuery.create().where('shared', true);
            const query = ApiQuery.create()
                .orWhere([() => owner, () => shared])
                .orWhere([() => owner, () => shared]);

            expect(filtersParam(query)).toBe('{"$or":[{"owner":1},{"shared":true}]}');
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

    describe('cursor lifetime', () => {
        it.each(ROW_SET_CALLS)('%s drops the token of a query paginated by it alone', (_method, call) => {
            const params = call(ApiQuery.create().cursor('tok')).toQueryParameters();

            expect([params['cursor'], params['pagination']]).toStrictEqual([undefined, 'cursor']);
        });

        it.each(ROW_SET_CALLS)('%s drops the token under forced cursor pagination', (_method, call) => {
            const params = call(ApiQuery.create().useCursorPagination().cursor('tok')).toQueryParameters();

            expect([params['cursor'], params['pagination']]).toStrictEqual([undefined, 'cursor']);
        });

        it.each(ROW_SET_CALLS)('%s leaves an offset-paginated query offset-paginated', (_method, call) => {
            const params = call(ApiQuery.create().page(2)).toQueryParameters();

            expect([params['cursor'], params['pagination'], params['page']]).toStrictEqual([undefined, undefined, 2]);
        });

        it.each([
            ['limit', (q: ApiQuery) => q.limit(10)],
            ['page', (q: ApiQuery) => q.page(2)],
            ['fieldsFor', (q: ApiQuery) => q.fieldsFor('user', ['id'])],
            ['aggregatesFor', (q: ApiQuery) => q.aggregatesFor('user', ['posts_count'])],
        ])('%s keeps the token', (_method, call) => {
            expect(call(ApiQuery.create().cursor('tok')).toQueryParameters()['cursor']).toBe('tok');
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
        it.each([1, 3])('emits page %s', n => {
            expect(ApiQuery.create().page(n).toQueryParameters()).toStrictEqual({ page: n });
        });
    });

    describe('limit', () => {
        it.each([1, 25])('emits limit %s', n => {
            expect(ApiQuery.create().limit(n).toQueryParameters()).toStrictEqual({ limit: n });
        });
    });

    describe.each([
        ['page', (q: ApiQuery, n: number) => q.page(n)],
        ['limit', (q: ApiQuery, n: number) => q.limit(n)],
    ] as const)('%s bounds', (label, set) => {
        it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('refuses %s', n => {
            expect(() => set(ApiQuery.create(), n)).toThrow(new QueryError(`The ${label} must be a positive integer.`));
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

    describe.each([
        ['fieldsFor', 'fields[user]', (q: ApiQuery, names: string[]) => q.fieldsFor('user', names)],
        ['aggregatesFor', 'aggregates[user]', (q: ApiQuery, names: string[]) => q.aggregatesFor('user', names)],
    ] as const)('%s selections', (method, key, select) => {
        it('emits an empty list as the explicit empty selection', () => {
            expect(select(ApiQuery.create(), []).toQueryParameters()).toStrictEqual({ [key]: '' });
        });

        it('replaces an earlier selection with the empty one', () => {
            expect(select(select(ApiQuery.create(), ['a']), []).toQueryParameters()).toStrictEqual({ [key]: '' });
        });

        it.each([[['']], [['  ']], [['a', '']]])('refuses the blank names in %j', names => {
            expect(() => select(ApiQuery.create(), names)).toThrow(
                new QueryError(`${method}("user") names must not be blank.`),
            );
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
