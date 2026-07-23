/**
 * Swap the manifest `exports` between its development and published forms.
 *
 * Locally the kernel is consumed straight from TypeScript source, so the
 * tracked manifest points every subpath export at `src`. The registry receives
 * compiled output, so the pack lifecycle rewrites each entry to its `dist`
 * conditional form before the tarball is built (`prepack`) and restores the
 * source form afterwards (`postpack`). npm does not honour an `exports`
 * override in `publishConfig`, so the swap is done here.
 *
 * Every `"./src/<path>.ts"` entry swaps to
 * `{ "types": "./dist/<path>.d.ts", "import": "./dist/<path>.js" }` and back;
 * the `./eslint` preset ships as plain JS either way and is left untouched. The
 * swap fails loudly rather than publish a manifest whose `exports` it could not
 * confidently rewrite.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { readFileSync, writeFileSync } from 'node:fs';

const mode = process.argv[2];

if (mode !== 'dist' && mode !== 'src') {
    console.error('usage: pack-exports.mjs <dist|src>');
    process.exit(1);
}

const SRC_ENTRY = /^\.\/src\/(.+)\.ts$/;

/**
 * Extract the subpath from a dist conditional entry.
 *
 * @param value - the exports entry value
 * @returns the captured subpath when it matches, else null
 */
function distSubpath(value) {
    if (typeof value !== 'object' || value === null) {
        return null;
    }

    const typesMatch = /^\.\/dist\/(.+)\.d\.ts$/.exec(value.types ?? '');
    const importMatch = /^\.\/dist\/(.+)\.js$/.exec(value.import ?? '');

    if (
        Object.keys(value).length !== 2 ||
        typesMatch === null ||
        importMatch === null ||
        typesMatch[1] !== importMatch[1]
    ) {
        return null;
    }

    return typesMatch[1];
}

const file = new URL('../package.json', import.meta.url);
const text = readFileSync(file, 'utf8');
const manifest = JSON.parse(text);
const rewritten = {};
let swapped = 0;

for (const [key, value] of Object.entries(manifest.exports)) {
    const srcMatch = typeof value === 'string' ? SRC_ENTRY.exec(value) : null;
    const distPath = distSubpath(value);

    if (mode === 'dist' && srcMatch !== null) {
        rewritten[key] = { types: `./dist/${srcMatch[1]}.d.ts`, import: `./dist/${srcMatch[1]}.js` };
        swapped += 1;
    } else if (mode === 'src' && distPath !== null) {
        rewritten[key] = `./src/${distPath}.ts`;
        swapped += 1;
    } else if (srcMatch !== null || distPath !== null) {
        rewritten[key] = value;
        swapped += 1;
    } else if (key === './eslint' || key.startsWith('./eslint/')) {
        rewritten[key] = value;
    } else {
        console.error(`pack-exports: unrecognised exports entry ${key}; refusing to guess`);
        process.exit(1);
    }
}

if (swapped === 0) {
    console.error('pack-exports: no swappable exports entries found; refusing to guess');
    process.exit(1);
}

// Only the exports block is rewritten, as text surgery, so the rest of the
// manifest keeps its committed formatting through every pack round-trip.
const entries = Object.entries(rewritten).map(([key, value]) => {
    if (typeof value === 'string') {
        return `        "${key}": "${value}"`;
    }

    return `        "${key}": {\n            "types": "${value.types}",\n            "import": "${value.import}"\n        }`;
});
const block = `"exports": {\n${entries.join(',\n')}\n    }`;
const updated = text.replace(/"exports": \{[\s\S]*?\n {4}\}/, block);

if (updated === text && !text.includes(block)) {
    console.error('pack-exports: exports block not found; refusing to guess');
    process.exit(1);
}

writeFileSync(file, updated);
