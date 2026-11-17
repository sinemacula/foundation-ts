/**
 * Benchmarks for compiling list queries.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe } from 'vitest';

import { measure } from './support/measure';

import { ApiQuery } from '../src/query/api-query';

/**
 * Chain `count` `where` calls on distinct fields.
 */
function chainedWheres(count: number): ApiQuery {
    let query = ApiQuery.create();

    for (let index = 0; index < count; index++) {
        query = query.where(`field_${String(index)}`, index);
    }

    return query;
}

describe('ApiQuery', () => {
    measure('compiles a realistic list query', () => {
        ApiQuery.create()
            .where('status', 'active')
            .where('total', '$ge', 100)
            .whereIn('channel', ['web', 'mobile'])
            .whereRelation('customer', relation => relation.where('country', 'GB'))
            .search('smith')
            .orderBy('created_at', 'desc')
            .fieldsFor('order', ['id', 'total', 'status', 'created_at'])
            .page(2)
            .limit(25)
            .toQueryString();
    });

    for (const count of [200, 1000]) {
        measure(`compiles ${String(count)} chained where calls`, () => {
            chainedWheres(count).toQueryString();
        });
    }

    measure('compiles 100 whereRelation merges on one relation', () => {
        let query = ApiQuery.create();

        for (let index = 0; index < 100; index++) {
            query = query.whereRelation('customer', relation => relation.where(`field_${String(index)}`, index));
        }

        query.toQueryString();
    });
});
