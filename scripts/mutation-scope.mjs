/**
 * List the mutable source files changed against a base ref, for scoped
 * mutation.
 *
 * The reusable quality-gates workflow feeds this list to Stryker's `--mutate`
 * on pull requests so only the touched files are mutated; the full suite runs
 * on a schedule. The predicate below MUST mirror the `mutate` array in
 * `stryker.config.json`, or the scoped gate and the full run would disagree.
 *
 * Usage: `node scripts/mutation-scope.mjs --base <ref>` prints the changed
 * mutable files, one per line; empty output means nothing to mutate.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { execFileSync } from 'node:child_process';

/** Whether a repo-relative POSIX path is in scope for mutation. */
function isMutable(path) {
    if (!path.startsWith('src/') || !path.endsWith('.ts')) {
        return false;
    }

    return !(path.endsWith('.test.ts') || path.includes('/test-support/'));
}

/** The mutable files changed between `base` and HEAD (deletions excluded). */
function changedMutableFiles(base) {
    const diff = execFileSync('git', ['diff', '--name-only', '--diff-filter=d', `${base}...HEAD`], {
        encoding: 'utf8',
    });

    return diff.split('\n').filter(path => path !== '' && isMutable(path));
}

const baseIndex = process.argv.indexOf('--base');
const base = baseIndex === -1 ? 'origin/master' : process.argv[baseIndex + 1];

for (const file of changedMutableFiles(base)) {
    console.log(file);
}
