/**
 * Print the mutable source files a branch touches against `--base <ref>`, one
 * per line, so pull requests mutate only those files. A changed or deleted test
 * scopes the source it covers, so weakening a test alone still runs the gate.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { minimatch } from 'minimatch';

/** Source tests named after something other than the file they cover. */
const TEST_SOURCES = [
    ['src/app/session-http.integration.test.ts', 'src/app/wire-http-client.ts'],
    ['src/http/fetch-http-client-*.test.ts', 'src/http/fetch-http-client.ts'],
    ['src/http/url-search-params-surface.test.ts', 'src/http/fetch-http-client.ts'],
    ['src/session/session-delayed-visibility.integration.test.ts', 'src/session/record-session-persistence.ts'],
];

const SOURCE_TEST = /^src\/.+\.test\.ts$/;

const { mutate } = JSON.parse(readFileSync('stryker.config.json', 'utf8'));

/**
 * Whether a repo-relative POSIX path is mutated, applying the `mutate` globs in
 * order as Stryker does: a `!` glob removes what the globs before it added.
 */
function isMutable(path) {
    let included = false;

    for (const glob of mutate) {
        const negated = glob.startsWith('!');

        if (minimatch(path, negated ? glob.slice(1) : glob)) {
            included = !negated;
        }
    }

    return included;
}

/** Run git and return its output lines. */
function git(...args) {
    return execFileSync('git', args, { encoding: 'utf8' })
        .split('\n')
        .filter(line => line !== '');
}

/**
 * The source a changed test covers, or undefined when it maps to none: its
 * same-named counterpart when that exists on either side of the diff or is not
 * mutated anyway, else a TEST_SOURCES entry.
 */
function sourceOf(test, known) {
    const counterpart = test.replace(/\.test\.ts$/, '.ts');

    if (known.has(counterpart) || !isMutable(counterpart)) {
        return counterpart;
    }

    return TEST_SOURCES.find(([glob]) => minimatch(test, glob))?.[1];
}

const baseIndex = process.argv.indexOf('--base');
const base = baseIndex === -1 ? 'origin/master' : process.argv[baseIndex + 1];
const [mergeBase] = git('merge-base', base, 'HEAD');
const atHead = new Set(git('ls-tree', '-r', '--name-only', 'HEAD'));
const known = new Set([...atHead, ...git('ls-tree', '-r', '--name-only', mergeBase)]);
const scope = new Set();
const unmapped = [];

for (const path of git('diff', '--name-only', '--no-renames', `${base}...HEAD`)) {
    const source = SOURCE_TEST.test(path) ? sourceOf(path, known) : path;

    if (source === undefined) {
        unmapped.push(path);
    } else if (atHead.has(source) && isMutable(source)) {
        scope.add(source);
    }
}

if (unmapped.length > 0) {
    console.error(`No source maps to ${unmapped.join(', ')}; add it to TEST_SOURCES in scripts/mutation-scope.mjs.`);
    process.exit(1);
}

for (const file of [...scope].sort()) {
    console.log(file);
}
