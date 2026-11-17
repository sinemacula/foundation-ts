/**
 * Benchmarks for permission checks.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe } from 'vitest';

import { measure } from './support/measure';

import { PermissionSet } from '../src/authorization/permission-set';

describe('PermissionSet.allows', () => {
    for (const count of [50, 500]) {
        const set = new PermissionSet(Array.from({ length: count }, (_, index) => `resource_${String(index)}.view`));

        for (const [label, permission] of [
            ['an early hit', 'resource_0.view'],
            ['the last hit', `resource_${String(count - 1)}.view`],
            ['a miss', 'unknown.view'],
        ] as const) {
            measure(`checks ${label} over ${String(count)} grants`, () => {
                set.allows(permission);
            });
        }
    }
});
