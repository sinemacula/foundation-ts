/**
 * Package build.
 *
 * Transforms the kernel source tree file-by-file into the published `dist/`:
 * every module keeps its path so a subpath import resolves to a single file
 * with no barrel and no bundler chunks. Runtime files and their declarations
 * both carry explicit relative extensions so the output resolves cleanly under
 * every module-resolution mode, not only a bundler's.
 *
 * mkdist extensions `from` specifiers but leaves bare side-effect imports
 * (`import './x'`, used here for module augmentation) untouched, which strict
 * ESM resolvers reject. The post-pass closes that gap.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { mkdist } from 'mkdist';

const { writtenFiles } = await mkdist({
    rootDir: process.cwd(),
    srcDir: 'src',
    distDir: 'dist',
    cleanDist: true,
    format: 'esm',
    ext: 'js',
    pattern: ['**/*.ts', '!**/*.test.ts', '!**/test-support/**'],
    declaration: true,
    addRelativeDeclarationExtensions: true,
});

const BARE_IMPORT = /(\bimport\s+(['"]))(\.\.?\/[^'"]*)(\2)/g;

let patched = 0;

for (const file of writtenFiles) {
    if (!file.endsWith('.js') && !file.endsWith('.d.ts')) {
        continue;
    }

    const source = readFileSync(file, 'utf8');
    const next = source.replace(BARE_IMPORT, (match, prefix, _quote, spec, quote) =>
        /\.(js|mjs|cjs|json)$/.test(spec) ? match : `${prefix}${spec}.js${quote}`,
    );

    if (next !== source) {
        writeFileSync(file, next);
        patched++;
    }
}

console.log(`mkdist: wrote ${writtenFiles.length} files (${patched} extension fix-ups)`);
