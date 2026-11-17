/**
 * Compile `src/` file-by-file into `dist/`, then add the `.js` extension mkdist
 * leaves off bare side-effect imports, which strict ESM resolvers reject.
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
    // test-support ships the realtime contract; the fake socket stays private.
    pattern: ['**/*.ts', '!**/*.test.ts', '!**/test-support/fake-web-socket.ts'],
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
