/**
 * Knip dead-code detection configuration.
 *
 * A single-package repository: production entries come from the manifest's
 * explicit `exports` map, and the test, tooling and config files are listed
 * statically. The staged qlty sources are external tooling, not project code.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { KnipConfig } from 'knip';

const config: KnipConfig = {
    entry: ['src/**/*.test.ts', 'stryker.config.json', 'scripts/*.mjs'],
    project: ['src/**/*.ts', 'scripts/**/*.mjs'],
    ignoreBinaries: ['qlty'],
    ignoreExportsUsedInFile: true,
};

export default config;
