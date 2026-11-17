/**
 * Benchmarks for unwrapping list envelopes.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe } from 'vitest';

import { measure } from './support/measure';

import type { RawRecord } from '../src/query/envelope';
import { unwrapList } from '../src/query/envelope';

/**
 * Pass a record through unchanged.
 */
function identity(raw: RawRecord): RawRecord {
    return raw;
}

/**
 * Build a length-aware list envelope of `count` rows.
 */
function page(count: number, next: string | null = null): unknown {
    return {
        data: Array.from({ length: count }, (_, index) => ({ id: index, total: index * 10 })),
        meta: { continue: next !== null, total: count, count },
        links: { self: null, first: null, prev: null, next, last: null },
    };
}

const LONG_LINK = `https://api.example.test/orders?filters=${'x'.repeat(8 * 1024)}&cursor=eyJpZCI6MTAwfQ`;

describe('unwrapList', () => {
    for (const count of [25, 1000, 10_000]) {
        const payload = page(count);

        measure(`unwraps ${String(count)} rows`, () => {
            unwrapList(payload, identity);
        });
    }

    const cursorPage = page(25, LONG_LINK);

    measure('reads the cursor from an 8 KB next link', () => {
        unwrapList(cursorPage, identity);
    });
});
