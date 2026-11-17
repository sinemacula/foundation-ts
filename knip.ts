/**
 * Knip configuration; production entries are the sources behind `exports`.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { KnipConfig } from 'knip';

import manifest from './package.json' with { type: 'json' };

const sourceEntries = Object.values(manifest.exports).map(({ default: target }) =>
    target.replace(/^\.\/dist\/(.+)\.js$/, 'src/$1.ts'),
);

const config: KnipConfig = {
    entry: [
        ...sourceEntries,
        'src/**/*.test.ts',
        'test/**/*.test.ts',
        'stryker.config.json',
        'scripts/*.mjs',
        'smoke/*/run.mjs',
    ],
    project: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.mjs', 'smoke/**/*.{js,mjs}'],
    ignoreBinaries: ['qlty'],
    ignoreExportsUsedInFile: true,
};

export default config;
