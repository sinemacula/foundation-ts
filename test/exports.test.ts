/**
 * Unit tests for the exports map: every entry points at its built files and
 * source, and every source module is either exported or deliberately
 * unexported.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import manifest from '../package.json' with { type: 'json' };

const SRC = resolve(import.meta.dirname, '..', 'src');

/** Source modules consumers reach only through the exported ones. */
const INTERNAL_MODULES = [
    'analytics/console-analytics-tracker',
    'http/abort-scope',
    'http/response-error',
    'logging/console-logger',
    'realtime/test-support/realtime-contract-cases',
    'reporting/console-error-reporter',
    'support/deep-freeze',
    'support/url',
];

/** Test doubles the build leaves out of the package. */
const UNSHIPPED_MODULES = ['realtime/test-support/fake-web-socket'];

const entries = Object.entries(manifest.exports);
const exported = new Set(entries.map(([key]) => key.slice(2)));
const modules = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map(file => file.split('\\').join('/'))
    .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts'))
    .map(file => file.slice(0, -'.ts'.length))
    .sort();

describe('exports map', () => {
    it.each(entries)('maps %s to its built files and an existing source', (key, targets) => {
        const path = key.slice(2);

        expect(targets).toEqual({ types: `./dist/${path}.d.ts`, default: `./dist/${path}.js` });
        expect(existsSync(join(SRC, `${path}.ts`))).toBe(true);
    });

    it.each(modules)('exports %s or lists it as unexported', module => {
        expect([...exported, ...INTERNAL_MODULES, ...UNSHIPPED_MODULES]).toContain(module);
    });

    it.each([...INTERNAL_MODULES, ...UNSHIPPED_MODULES])('keeps %s as an existing, unexported module', module => {
        expect(modules).toContain(module);
        expect(exported.has(module)).toBe(false);
    });
});
