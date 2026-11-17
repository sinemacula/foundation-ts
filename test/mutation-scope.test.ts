/**
 * Black-box tests for the mutation scope script, run against throwaway git
 * repositories.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { SpawnSyncReturns } from 'node:child_process';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'mutation-scope.mjs');

// Isolate the fixtures from the user's git config: signing, hooks, templates.
const GIT_ENV = {
    ...process.env,
    // biome-ignore-start lint/style/useNamingConvention: git environment variables
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
    // biome-ignore-end lint/style/useNamingConvention: git environment variables
};

const BASE_FILES = [
    'src/a/x.ts',
    'src/a/x.test.ts',
    'src/b/y.ts',
    'src/b/y.test.ts',
    'src/b/z.ts',
    'src/http/fetch-http-client.ts',
    'src/http/fetch-http-client-auth.test.ts',
    'src/orphan/gone.ts',
    'src/orphan/gone.test.ts',
    'src/realtime/test-support/contract.ts',
    'test/tool.test.ts',
    'README.md',
];

/** What a branch does to the base tree. */
interface Change {
    /** Files written, created or modified. */
    readonly write?: readonly string[];

    /** Files deleted. */
    readonly remove?: readonly string[];

    /** Files moved, as `[from, to]`. */
    readonly move?: readonly (readonly [string, string])[];
}

let repo: string;
let writes = 0;

/**
 * Write a file in the fixture repository, its content unique per call so every
 * write registers as a change.
 */
function write(path: string): void {
    const target = join(repo, path);

    mkdirSync(dirname(target), { recursive: true });
    writes++;
    writeFileSync(target, `export const id = ${String(writes)};\n`);
}

/**
 * Run git in the fixture repository.
 */
function git(...args: string[]): void {
    execFileSync('git', args, { cwd: repo, env: GIT_ENV, stdio: 'ignore' });
}

/**
 * Commit the base tree, tag it `base`, apply the change on top and commit it.
 */
function branch(change: Change, files: readonly string[] = BASE_FILES): void {
    git('init', '--quiet', '--initial-branch', 'master');
    files.forEach(write);
    git('add', '--all');
    git('commit', '--quiet', '--message', 'base');
    git('tag', 'base');

    change.write?.forEach(write);
    change.remove?.forEach(path => {
        rmSync(join(repo, path));
    });
    change.move?.forEach(([from, to]) => {
        git('mv', from, to);
    });
    git('add', '--all');
    git('commit', '--quiet', '--message', 'change');
}

/**
 * Run the scope script against `base` and capture its outcome.
 */
function scope(): Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr'> {
    const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT, '--base', 'base'], {
        cwd: repo,
        env: GIT_ENV,
        encoding: 'utf8',
    });

    return { status, stdout, stderr };
}

beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'mutation-scope-'));
    copyFileSync(join(ROOT, 'stryker.config.json'), join(repo, 'stryker.config.json'));
});

afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
});

describe('mutation scope', () => {
    it.each<[string, Change, string[]]>([
        ['a changed source', { write: ['src/a/x.ts'] }, ['src/a/x.ts']],
        ['a changed test alone', { write: ['src/a/x.test.ts'] }, ['src/a/x.ts']],
        ['a source and its test', { write: ['src/a/x.ts', 'src/a/x.test.ts'] }, ['src/a/x.ts']],
        [
            'a split test through the mapping table',
            { write: ['src/http/fetch-http-client-auth.test.ts'] },
            ['src/http/fetch-http-client.ts'],
        ],
        ['a deleted test', { remove: ['src/a/x.test.ts'] }, ['src/a/x.ts']],
        [
            'a renamed test, on both sides',
            { move: [['src/a/x.test.ts', 'src/b/z.test.ts']] },
            ['src/a/x.ts', 'src/b/z.ts'],
        ],
        ['several sources, sorted', { write: ['src/b/y.ts', 'src/a/x.test.ts'] }, ['src/a/x.ts', 'src/b/y.ts']],
        ['a test whose source was deleted', { write: ['src/orphan/gone.test.ts'], remove: ['src/orphan/gone.ts'] }, []],
        ['a deleted source', { remove: ['src/b/y.ts'] }, []],
        ['a test inside test-support', { write: ['src/realtime/test-support/helper.test.ts'] }, []],
        [
            'test-support and files outside src',
            { write: ['src/realtime/test-support/contract.ts', 'test/tool.test.ts', 'README.md'] },
            [],
        ],
    ])('scopes %s', (_, change, expected) => {
        branch(change);

        expect(scope()).toEqual({ status: 0, stdout: expected.map(file => `${file}\n`).join(''), stderr: '' });
    });

    it('fails on a source test that maps to no source', () => {
        branch({ write: ['src/a/x.test.ts', 'src/a/unmapped.test.ts'] });

        expect(scope()).toEqual({
            status: 1,
            stdout: '',
            stderr: 'No source maps to src/a/unmapped.test.ts; add it to TEST_SOURCES in scripts/mutation-scope.mjs.\n',
        });
    });

    it('applies the mutate globs in order, so a later glob re-includes', () => {
        writeFileSync(
            join(repo, 'stryker.config.json'),
            JSON.stringify({ mutate: ['src/**/*.ts', '!src/legacy/**', 'src/legacy/kept.ts'] }),
        );
        branch({ write: ['src/legacy/kept.ts', 'src/legacy/dropped.ts'] }, [
            'src/legacy/kept.ts',
            'src/legacy/dropped.ts',
        ]);

        expect(scope()).toEqual({ status: 0, stdout: 'src/legacy/kept.ts\n', stderr: '' });
    });
});
