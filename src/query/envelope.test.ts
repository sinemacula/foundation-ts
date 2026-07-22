/**
 * Unit tests for envelope unwrapping.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import type { RawRecord } from './envelope';
import { unwrapItem, unwrapList } from './envelope';

/** A minimal domain type used to exercise the mapper contract. */
interface Widget {
    readonly id: string;
    readonly name: string;
}

/**
 * Build a `Record<string, unknown>` from an array of `[key, value]` pairs.
 *
 * Keeps snake_case wire-field names out of object-literal key positions so
 * Biome's naming-convention rule never sees them.
 *
 * @param entries - key-value pairs for the record
 * @returns a plain `Record<string, unknown>`
 */
function wire(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
    return Object.fromEntries(entries);
}

/**
 * Validate and map a raw record onto a `Widget`, mirroring a real resource
 * mapper.
 *
 * @param raw - the raw wire record
 * @returns the mapped widget
 * @throws Error when required fields are missing or of the wrong type
 */
function mapWidget(raw: RawRecord): Widget {
    if (typeof raw['id'] !== 'string' || typeof raw['name'] !== 'string') {
        throw new Error('The widget response did not match the expected shape.');
    }

    return { id: raw['id'], name: raw['name'] };
}

describe('unwrapItem', () => {
    it('maps the data envelope onto the mapped value', () => {
        const payload = {
            data: wire([
                ['id', 'w1'],
                ['name', 'Widget One'],
            ]),
        };

        expect(unwrapItem(payload, mapWidget)).toEqual({ id: 'w1', name: 'Widget One' });
    });

    it('throws when the payload is not a record', () => {
        expect(() => unwrapItem('not-a-record', mapWidget)).toThrow(
            'The response did not match the expected envelope shape.',
        );
    });

    it('throws when data is missing', () => {
        expect(() => unwrapItem({}, mapWidget)).toThrow('The response did not match the expected envelope shape.');
    });

    it('throws when data is not a record', () => {
        expect(() => unwrapItem({ data: [1, 2] }, mapWidget)).toThrow(
            'The response did not match the expected envelope shape.',
        );
    });

    it('propagates errors thrown by the mapper', () => {
        const payload = { data: wire([['id', 'w1']]) };

        expect(() => unwrapItem(payload, mapWidget)).toThrow('The widget response did not match the expected shape.');
    });
});

describe('unwrapList', () => {
    it('maps every entry in the data array', () => {
        const payload = {
            data: [
                wire([
                    ['id', 'w1'],
                    ['name', 'Widget One'],
                ]),
                wire([
                    ['id', 'w2'],
                    ['name', 'Widget Two'],
                ]),
            ],
        };

        const result = unwrapList(payload, mapWidget);

        expect(result.items).toEqual([
            { id: 'w1', name: 'Widget One' },
            { id: 'w2', name: 'Widget Two' },
        ]);
    });

    it('throws when the payload is not a record', () => {
        expect(() => unwrapList(null, mapWidget)).toThrow('The response did not match the expected envelope shape.');
    });

    it('throws when data is missing', () => {
        expect(() => unwrapList({}, mapWidget)).toThrow('The response did not match the expected envelope shape.');
    });

    it('throws when data is not an array', () => {
        expect(() => unwrapList({ data: {} }, mapWidget)).toThrow(
            'The response did not match the expected envelope shape.',
        );
    });

    it('throws when an entry in the data array is not a record', () => {
        expect(() => unwrapList({ data: ['not-a-record'] }, mapWidget)).toThrow(
            'The response did not match the expected envelope shape.',
        );
    });

    it('propagates errors thrown by the mapper', () => {
        const payload = { data: [wire([['id', 'w1']])] };

        expect(() => unwrapList(payload, mapWidget)).toThrow('The widget response did not match the expected shape.');
    });

    describe('pagination meta', () => {
        it('maps a valid meta block', () => {
            const payload = {
                data: [],
                meta: wire([
                    ['current_page', 2],
                    ['last_page', 5],
                    ['per_page', 25],
                    ['total', 111],
                ]),
            };

            expect(unwrapList(payload, mapWidget).meta).toEqual({
                currentPage: 2,
                lastPage: 5,
                perPage: 25,
                total: 111,
            });
        });

        it('is null when meta is absent', () => {
            expect(unwrapList({ data: [] }, mapWidget).meta).toBeNull();
        });

        it('is null when meta is not a record', () => {
            expect(unwrapList({ data: [], meta: 'not-a-record' }, mapWidget).meta).toBeNull();
        });

        it('is null when current_page is missing', () => {
            const payload = {
                data: [],
                meta: wire([
                    ['last_page', 5],
                    ['per_page', 25],
                    ['total', 111],
                ]),
            };

            expect(unwrapList(payload, mapWidget).meta).toBeNull();
        });

        it('is null when last_page is not a number', () => {
            const payload = {
                data: [],
                meta: wire([
                    ['current_page', 2],
                    ['last_page', 'five'],
                    ['per_page', 25],
                    ['total', 111],
                ]),
            };

            expect(unwrapList(payload, mapWidget).meta).toBeNull();
        });

        it('is null when per_page is not a number', () => {
            const payload = {
                data: [],
                meta: wire([
                    ['current_page', 2],
                    ['last_page', 5],
                    ['per_page', 'twenty-five'],
                    ['total', 111],
                ]),
            };

            expect(unwrapList(payload, mapWidget).meta).toBeNull();
        });

        it('is null when total is not a number', () => {
            const payload = {
                data: [],
                meta: wire([
                    ['current_page', 2],
                    ['last_page', 5],
                    ['per_page', 25],
                    ['total', null],
                ]),
            };

            expect(unwrapList(payload, mapWidget).meta).toBeNull();
        });
    });
});
