/**
 * Unit tests for PermissionSet.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { PermissionSet } from './permission-set';

describe('PermissionSet', () => {
    it.each([
        ['posts:view', 'posts:view', true],
        ['posts:view', 'posts:edit', false],
        ['posts:view', 'posts:viewer', false],
        ['posts:view', 'Posts:View', false],
        ['posts:view', '', false],
        ['*', 'anything', true],
        ['*', '', true],
        ['*:*', 'posts:create', true],
        ['*:*', 'posts', false],
        ['*:view', 'posts:view', true],
        ['*:view', 'posts:edit', false],
        ['*:view', 'posts:comments:view', true],
        ['*:view', 'posts:view:all', false],
        ['posts:*:own', 'posts:edit:own', true],
        ['posts:*:own', 'posts:edit:all', false],
        ['posts:*:own', 'posts::own', true],
        ['posts:*', 'posts:create', true],
        ['posts:*', 'posts:', true],
        ['posts:*', 'posts', false],
        ['posts:*', 'postsx:create', false],
        ['posts:*', 'posts:edit:own', true],
        ['posts:create', 'posts:*', false],
        ['Posts:*', 'posts:view', false],
        ['users*', 'users', true],
        ['users*', 'usersx', true],
        ['users.*', 'users.view', true],
        ['users.*', 'users.edit.self', true],
        ['users.*', 'usersx.view', false],
        ['a*b*c', 'aXbYc', true],
        ['a*b*c', 'abc', true],
        ['a*b*c', 'aXc', false],
        ['a*b*c', 'acb', false],
        ['a**b', 'ab', true],
        ['*a', 'ba', true],
        ['a*ab', 'aab', true],
        ['a*ab', 'ab', false],
        ['*ab*bc', 'abc', false],
        ['*a*a*', 'aa', true],
        ['*a*a*', 'a', false],
        ['ab*b*', 'ab', false],
    ])('grant %j matches %j: %s', (grant, permission, expected) => {
        expect(new PermissionSet([grant]).allows(permission)).toBe(expected);
    });

    it.each([
        ['posts:?', 'posts:a'],
        ['posts:[ab]', 'posts:a'],
    ])('treats %j, which the server cannot store, as literal against %j', (grant, permission) => {
        expect(new PermissionSet([grant]).allows(permission)).toBe(false);
        expect(new PermissionSet([grant]).allows(grant)).toBe(true);
    });

    it('allows nothing when the granted set is empty', () => {
        expect(new PermissionSet([]).allows('posts:view')).toBe(false);
    });

    it.each([
        ['posts:view', true],
        ['users:edit', true],
        ['billing:view', false],
    ])('allows %s when any of several grants matches: %s', (permission, expected) => {
        const permissions = new PermissionSet(['billing:edit', 'posts:view', 'users:*']);

        expect(permissions.allows(permission)).toBe(expected);
    });
});
