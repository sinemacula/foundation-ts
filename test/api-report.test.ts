/**
 * Black-box tests for the public API report script, run against throwaway
 * packages with hand-written declarations.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { SpawnSyncReturns } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '..', 'scripts', 'api-report.mjs');
const STALE = 'api/foundation.api.md is out of date; run npm run api:report and review the diff.\n';

const ENTRY = [
    '/// <reference path="./globals.d.ts" />',
    "export * from './b.js';",
    "export type Lazy = import('./c.js').C;",
    'export declare function a(): void;',
].join('\n');

const DECLARATIONS: Readonly<Record<string, string>> = {
    'a.d.ts': ENTRY,
    'b.d.ts': 'export interface B { value: string; }',
    'c.d.ts': 'export interface C { value: string; }',
    'globals.d.ts': 'interface Hidden { value: string; }',
    'unused.d.ts': 'export interface Unused { value: string; }',
};

let dir: string;

/**
 * Write a declaration file into the fixture's `dist`.
 */
function declare(file: string, content: string): void {
    writeFileSync(join(dir, 'dist', file), `${content}\n`);
}

/**
 * Run the report script in the fixture and capture its outcome.
 */
function report(...args: string[]): Pick<SpawnSyncReturns<string>, 'status' | 'stderr'> {
    const { status, stderr } = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });

    return { status, stderr };
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'api-report-'));
    mkdirSync(join(dir, 'dist'));
    writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ exports: { './a': { types: './dist/a.d.ts', default: './dist/a.js' } } }),
    );
    Object.entries(DECLARATIONS).forEach(([file, content]) => {
        declare(file, content);
    });
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('api report', () => {
    it('reports every declaration reachable from an export entry', () => {
        expect(report()).toEqual({ status: 0, stderr: '' });

        const outline = readFileSync(join(dir, 'api', 'foundation.api.md'), 'utf8')
            .split('\n')
            .filter(line => /^(## |Exported |Internal\.)/.test(line));

        expect(outline).toEqual([
            '## dist/a.d.ts',
            'Exported as `@sinemacula/foundation/a`.',
            '## dist/b.d.ts',
            'Internal.',
            '## dist/c.d.ts',
            'Internal.',
            '## dist/globals.d.ts',
            'Internal.',
        ]);
    });

    it('passes the check against a fresh report', () => {
        report();

        expect(report('--check')).toEqual({ status: 0, stderr: '' });
    });

    it('fails the check when no report exists', () => {
        expect(report('--check')).toEqual({ status: 1, stderr: STALE });
    });

    it.each([
        ['a.d.ts', '(): void', '(): string'],
        ['b.d.ts', 'string', 'number'],
        ['c.d.ts', 'string', 'number'],
        ['globals.d.ts', 'string', 'number'],
    ])('fails the check after a change to %s', (file, from, to) => {
        report();
        declare(file, (DECLARATIONS[file] ?? '').replace(from, to));

        expect(report('--check')).toEqual({ status: 1, stderr: STALE });
    });

    it('ignores a change to an unreachable declaration', () => {
        report();
        declare('unused.d.ts', 'export interface Unused { value: number; }');

        expect(report('--check')).toEqual({ status: 0, stderr: '' });
    });

    it.each([
        ['an import', "export * from './missing.js';"],
        ['a triple-slash path reference', '/// <reference path="./missing.d.ts" />'],
    ])('fails on %s that resolves to no file', (_, content) => {
        declare('a.d.ts', content);

        expect(report()).toEqual({
            status: 1,
            stderr: 'dist/a.d.ts references ./missing.d.ts, which resolves to no declaration file.\n',
        });
    });
});
