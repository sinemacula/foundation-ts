/**
 * Pins the query string the React Native smoke scenario expects to what the
 * source produces, so the packed package is compared against src.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { ApiQuery } from '../src/query/api-query';

// Kept identical to EXPECTED_QUERY in smoke/react-native/scenario.js.
const EXPECTED_QUERY =
    'filters=%7B%22status%22%3A%22active%22%2C%22total%22%3A%7B%22%24ge%22%3A100%7D%2C%22customer%22%3A%7B%22country' +
    '%22%3A%22GB%22%7D%7D&order=created_at%3Adesc%2Cid&page=2&limit=25&fields%5Border%5D=id%2Ctotal';

describe('smoke scenario query', () => {
    it('compiles to the literal the packed package must match', () => {
        const compiled = ApiQuery.create()
            .where('status', 'active')
            .where('total', '$ge', 100)
            .whereRelation('customer', relation => relation.where('country', 'GB'))
            .orderBy('created_at', 'desc')
            .orderBy('id')
            .fieldsFor('order', ['id', 'total'])
            .page(2)
            .limit(25)
            .toQueryString();

        expect(compiled).toBe(EXPECTED_QUERY);
    });
});
