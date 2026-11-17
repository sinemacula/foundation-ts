/**
 * Benchmarks for permission checks.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { bench, describe } from 'vitest';

import { PermissionSet } from '../src/authorization/permission-set';

describe('PermissionSet.allows', () => {
    for (const count of [50, 500]) {
        const set = new PermissionSet(Array.from({ length: count }, (_, index) => `resource_${String(index)}.view`));

        for (const [label, permission] of [
            ['an early hit', 'resource_0.view'],
            ['the last hit', `resource_${String(count - 1)}.view`],
            ['a miss', 'unknown.view'],
        ] as const) {
            bench(`checks ${label} over ${String(count)} grants`, () => {
                set.allows(permission);
            });
        }
    }
});
