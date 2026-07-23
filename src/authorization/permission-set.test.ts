/**
 * Unit tests for PermissionSet.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { PermissionSet } from './permission-set';

describe('PermissionSet', () => {
    it('allows a permission that exactly matches a granted entry', () => {
        const permissions = new PermissionSet(['users.view']);

        expect(permissions.allows('users.view')).toBe(true);
    });

    it('does not allow a permission that is not granted', () => {
        const permissions = new PermissionSet(['users.view']);

        expect(permissions.allows('users.edit')).toBe(false);
    });

    it('is case-sensitive', () => {
        const permissions = new PermissionSet(['users.view']);

        expect(permissions.allows('Users.View')).toBe(false);
    });

    it('allows nothing when the granted set is empty', () => {
        const permissions = new PermissionSet([]);

        expect(permissions.allows('users.view')).toBe(false);
    });

    it('does not allow an empty permission string when not explicitly granted', () => {
        const permissions = new PermissionSet(['users.view']);

        expect(permissions.allows('')).toBe(false);
    });

    describe('dot-wildcard grants', () => {
        it('allows a direct child of the wildcard prefix', () => {
            const permissions = new PermissionSet(['users.*']);

            expect(permissions.allows('users.view')).toBe(true);
        });

        it('allows a nested descendant of the wildcard prefix', () => {
            const permissions = new PermissionSet(['users.*']);

            expect(permissions.allows('users.edit.self')).toBe(true);
        });

        it('does not allow a permission that only shares a text prefix, not a boundary', () => {
            const permissions = new PermissionSet(['users.*']);

            expect(permissions.allows('usersx.view')).toBe(false);
        });
    });

    describe('colon-wildcard grants', () => {
        it('allows a permission under the colon-delimited prefix', () => {
            const permissions = new PermissionSet(['users:*']);

            expect(permissions.allows('users:view')).toBe(true);
        });

        it('does not allow a permission that only shares a text prefix, not a boundary', () => {
            const permissions = new PermissionSet(['users:*']);

            expect(permissions.allows('usersx:view')).toBe(false);
        });
    });

    describe('global wildcard grant', () => {
        it('allows any permission', () => {
            const permissions = new PermissionSet(['*']);

            expect(permissions.allows('anything.at.all')).toBe(true);
        });

        it('allows an empty permission string', () => {
            const permissions = new PermissionSet(['*']);

            expect(permissions.allows('')).toBe(true);
        });
    });

    it('allows a permission covered by one of several granted entries', () => {
        const permissions = new PermissionSet(['billing.view', 'users.*']);

        expect(permissions.allows('users.edit')).toBe(true);
    });
});
