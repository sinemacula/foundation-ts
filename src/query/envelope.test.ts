/**
 * Unit tests for envelope unwrapping.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import type { RawRecord } from './envelope';
import { unwrapItem, unwrapList } from './envelope';
import { QueryError } from './query-error';

/** The message raised for a malformed envelope. */
const MALFORMED = 'The response did not match the expected envelope shape.';

/** A minimal domain type used to exercise the mapper contract. */
interface Widget {
    /** The widget identifier. */
    readonly id: string;

    /** The widget display name. */
    readonly name: string;
}

/**
 * Build a `Record<string, unknown>` from an array of `[key, value]` pairs.
 *
 * Keeps snake_case wire-field names out of object-literal key positions.
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

    it('hands the toolkit reserved keys to the mapper', () => {
        const record = wire([
            ['_type', 'widget'],
            ['_truncated', ['parts']],
            ['aggregates', wire([['parts_count', 30]])],
        ]);

        const seen = unwrapItem({ data: record }, raw => raw);

        expect(seen._type).toBe('widget');
        expect(seen._truncated).toEqual(['parts']);
        expect(seen.aggregates).toEqual(wire([['parts_count', 30]]));
    });

    it.each([
        ['_type', 7],
        ['_truncated', 'parts'],
        ['_truncated', ['parts', 3]],
        ['aggregates', ['parts_count']],
    ])('throws when the reserved key %s is malformed', (key, value) => {
        expect(() => unwrapItem({ data: wire([[key, value]]) }, raw => raw)).toThrow(new QueryError(MALFORMED));
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
        it('maps a length-aware meta block', () => {
            const payload = { data: [], meta: { total: 111, count: 25, continue: true } };

            expect(unwrapList(payload, mapWidget).meta).toEqual({
                mode: 'length-aware',
                total: 111,
                count: 25,
                hasMore: true,
            });
        });

        it('maps a cursor meta block', () => {
            const payload = { data: [], meta: { continue: false } };

            expect(unwrapList(payload, mapWidget).meta).toEqual({ mode: 'cursor', hasMore: false });
        });

        it('is null when meta is absent', () => {
            expect(unwrapList({ data: [] }, mapWidget).meta).toBeNull();
        });

        it('is null when meta is not a record', () => {
            expect(unwrapList({ data: [], meta: 'not-a-record' }, mapWidget).meta).toBeNull();
        });

        it('is null when continue is missing', () => {
            expect(unwrapList({ data: [], meta: { total: 1, count: 1 } }, mapWidget).meta).toBeNull();
        });

        it('is null when continue is not a boolean', () => {
            expect(unwrapList({ data: [], meta: { continue: 1 } }, mapWidget).meta).toBeNull();
        });

        it('is null when total is present but count is not', () => {
            expect(unwrapList({ data: [], meta: { total: 4, continue: true } }, mapWidget).meta).toBeNull();
        });

        it('is null when count is present but total is not', () => {
            expect(unwrapList({ data: [], meta: { count: 4, continue: true } }, mapWidget).meta).toBeNull();
        });

        it('is null when total is not a number', () => {
            expect(unwrapList({ data: [], meta: { total: '4', count: 4, continue: true } }, mapWidget).meta).toBeNull();
        });

        it('is null when count is not a number', () => {
            expect(
                unwrapList({ data: [], meta: { total: 4, count: null, continue: true } }, mapWidget).meta,
            ).toBeNull();
        });
    });

    describe('pagination links', () => {
        it('maps length-aware links and finds no cursor in them', () => {
            const payload = {
                data: [],
                links: {
                    self: 'https://api.test/users?page=2',
                    first: 'https://api.test/users?page=1',
                    prev: 'https://api.test/users?page=1',
                    next: 'https://api.test/users?page=3',
                    last: 'https://api.test/users?page=5',
                },
            };

            const result = unwrapList(payload, mapWidget);

            expect(result.links).toEqual(payload.links);
            expect(result.nextCursor).toBeNull();
            expect(result.prevCursor).toBeNull();
        });

        it('maps cursor links and reads both cursors from them', () => {
            const payload = {
                data: [],
                meta: { continue: true },
                links: {
                    self: 'https://api.test/users?pagination=cursor',
                    prev: 'https://api.test/users?pagination=cursor&cursor=eyJpZCI6MX0',
                    next: 'https://api.test/users?pagination=cursor&cursor=eyJpZCI6MjV9',
                },
            };

            const result = unwrapList(payload, mapWidget);

            expect(result.links).toEqual({ ...payload.links, first: null, last: null });
            expect(result.nextCursor).toBe('eyJpZCI6MjV9');
            expect(result.prevCursor).toBe('eyJpZCI6MX0');
        });

        it('decodes an encoded cursor and ignores a fragment', () => {
            const payload = { data: [], links: { next: '/users?cursor=a%2Bb+c&limit=5#top' } };

            expect(unwrapList(payload, mapWidget).nextCursor).toBe('a+b c');
        });

        it.each([
            ['another parameter ending in cursor', '/users?precursor=abc'],
            ['an empty cursor', '/users?cursor=&limit=5'],
            ['a cursor with no value', '/users?limit=5&cursor'],
            ['a cursor only in the fragment', '/users#cursor=abc'],
            ['a cursor only after the fragment marker', '/users?limit=5#x&cursor=abc'],
        ])('finds no cursor in a link with %s', (_label, next) => {
            expect(unwrapList({ data: [], links: { next } }, mapWidget).nextCursor).toBeNull();
        });

        it('reads a cursor that is not the first parameter', () => {
            const payload = { data: [], links: { prev: 'users?limit=5&cursor=abc&order=id' } };

            expect(unwrapList(payload, mapWidget).prevCursor).toBe('abc');
        });

        it('reads an absent, null, empty or non-string link as null', () => {
            const payload = { data: [], links: { self: '', prev: null, next: 5 } };

            expect(unwrapList(payload, mapWidget).links).toEqual({
                self: null,
                first: null,
                prev: null,
                next: null,
                last: null,
            });
        });

        it('is null when links are absent or not a record', () => {
            expect(unwrapList({ data: [] }, mapWidget)).toMatchObject({
                links: null,
                nextCursor: null,
                prevCursor: null,
            });
            expect(unwrapList({ data: [], links: ['x'] }, mapWidget).links).toBeNull();
        });

        it('throws a query error for a malformed escape in a cursor', () => {
            const payload = { data: [], links: { next: '/users?cursor=%E0%A4%A' } };

            expect(() => unwrapList(payload, mapWidget)).toThrow(
                expect.objectContaining({ name: 'QueryError', message: MALFORMED, cause: expect.any(URIError) }),
            );
        });
    });
});
