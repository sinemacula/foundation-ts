/**
 * Tests that screen filters compiled onto a list definition's base query only
 * ever narrow it.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { ApiQuery } from './api-query';
import type { ListFilter } from './list-filter';
import { filter } from './list-filter';
import type { FilterValueOf, ListQueryDefinition } from './list-query-definition';
import { defineListQuery } from './list-query-definition';

/**
 * Compile a list query the way the platform bindings do: the base first, then
 * each set filter in order.
 */
function compile<Filters extends Record<string, ListFilter<never>>>(
    definition: ListQueryDefinition<Filters>,
    values: { readonly [Name in keyof Filters]?: FilterValueOf<Filters[Name]> },
): unknown {
    const filters: Readonly<Record<string, ListFilter<unknown>>> = definition.filters ?? {};
    let query = ApiQuery.create();

    if (definition.base !== undefined) {
        query = definition.base(query);
    }

    for (const [name, value] of Object.entries(values)) {
        query = filters[name]?.apply(query, value) ?? query;
    }

    return JSON.parse(String(query.toQueryParameters()['filters']));
}

/**
 * Build a wire-style object from entry tuples, keeping `$`-prefixed keys out of
 * object-literal key positions.
 */
function wire(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
    return Object.fromEntries(entries);
}

/** A custom filter whose `true` value keeps drafts and reviews only. */
const unpublished = filter.custom<boolean>(query =>
    query.orWhere([q => q.where('status', 'draft'), q => q.where('status', 'review')]),
);

/** The `$or` group a base query scopes to the user's own or shared rows. */
const scoped = [{ owner: 1 }, { shared: true }];

/** The `$or` group the unpublished filter adds. */
const drafts = [{ status: 'draft' }, { status: 'review' }];

describe('list query composition', () => {
    it.each([
        [
            'a filter group beside a base group',
            compile(
                defineListQuery({
                    base: q => q.orWhere([o => o.where('owner', 1), s => s.where('shared', true)]),
                    filters: { unpublished },
                }),
                { unpublished: true },
            ),
            wire([
                ['$or', scoped],
                ['$and', [wire([['$or', drafts]])]],
            ]),
        ],
        [
            'a filter equality beside a base equality on the same field',
            compile(
                defineListQuery({
                    base: q => q.where('status', 'published'),
                    filters: { status: filter.equals('status') },
                }),
                { status: 'draft' },
            ),
            wire([
                ['status', 'published'],
                ['$and', [{ status: 'draft' }]],
            ]),
        ],
        [
            'two filter groups beside each other',
            compile(
                defineListQuery({
                    filters: {
                        unpublished,
                        scope: filter.custom<boolean>(query =>
                            query.orWhere([o => o.where('owner', 1), s => s.where('shared', true)]),
                        ),
                    },
                }),
                { unpublished: true, scope: true },
            ),
            wire([
                ['$or', drafts],
                ['$and', [wire([['$or', scoped]])]],
            ]),
        ],
        [
            'a filter relation condition beside the base one on the same row',
            compile(
                defineListQuery({
                    base: q => q.whereHas('team', t => t.where('id', 1)),
                    filters: {
                        team: filter.custom<number>((query, id) => query.whereHas('team', t => t.where('id', id))),
                    },
                }),
                { team: 2 },
            ),
            wire([
                [
                    '$has',
                    {
                        team: wire([
                            ['id', 1],
                            ['$and', [{ id: 2 }]],
                        ]),
                    },
                ],
            ]),
        ],
        [
            'a filter repeating the base condition once',
            compile(
                defineListQuery({
                    base: q => q.where('status', 'published'),
                    filters: { status: filter.equals('status') },
                }),
                { status: 'published' },
            ),
            { status: 'published' },
        ],
    ])('keeps the base when compiling %s', (_label, filters, expected) => {
        expect(filters).toStrictEqual(expected);
    });
});
