/**
 * Knip dead-code detection configuration.
 *
 * A single-package repository: production entries are the sources behind the
 * manifest's `exports` map, which points at the compiled `dist` output, and the
 * test, tooling and config files are listed statically. The staged qlty sources
 * are external tooling, not project code.
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
    entry: [...sourceEntries, 'src/**/*.test.ts', 'stryker.config.json', 'scripts/*.mjs'],
    project: ['src/**/*.ts', 'scripts/**/*.mjs'],
    ignoreBinaries: ['qlty'],
    ignoreExportsUsedInFile: true,
};

export default config;
