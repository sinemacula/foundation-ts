/**
 * Unit tests for defineListQuery and the ListQueryDefinition schema.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import type { ApiQuery } from './api-query';
import { filter } from './list-filter';
import { defineListQuery } from './list-query-definition';

describe('defineListQuery', () => {
    it('returns the definition unchanged', () => {
        const definition = defineListQuery({
            filters: {
                status: filter.equals('status'),
            },
            pageSize: 10,
        });

        expect(definition.pageSize).toBe(10);
    });

    it('freezes the returned definition', () => {
        const definition = defineListQuery({});

        expect(Object.isFrozen(definition)).toBe(true);
    });

    it('accepts a definition with no properties', () => {
        const definition = defineListQuery({});

        expect(definition.filters).toBeUndefined();
        expect(definition.search).toBeUndefined();
        expect(definition.sortable).toBeUndefined();
        expect(definition.defaultSort).toBeUndefined();
        expect(definition.pageSize).toBeUndefined();
        expect(definition.base).toBeUndefined();
    });

    it('preserves the base function', () => {
        const base = (q: ApiQuery) => q.fields(['id', 'name']);
        const definition = defineListQuery({ base });

        expect(definition.base).toBe(base);
    });

    it('preserves the search filter', () => {
        const searchFilter = filter.text('name');
        const definition = defineListQuery({ search: searchFilter });

        expect(definition.search).toBe(searchFilter);
    });

    it('preserves sortable columns', () => {
        const definition = defineListQuery({ sortable: ['name', 'createdAt'] });

        expect(definition.sortable).toEqual(['name', 'createdAt']);
    });

    it('preserves defaultSort', () => {
        const definition = defineListQuery({ defaultSort: { column: 'name', direction: 'asc' } });

        expect(definition.defaultSort).toEqual({ column: 'name', direction: 'asc' });
    });

    it('preserves a filters record with multiple entries', () => {
        const definition = defineListQuery({
            filters: {
                status: filter.equals('status'),
                name: filter.text('name'),
            },
        });

        expect(definition.filters?.status).toBeDefined();
        expect(definition.filters?.name).toBeDefined();
    });
});
