/**
 * Install the packed package into a scratch consumer, import every public
 * subpath under plain Node, and type-check a consumer importing them all as a
 * Node16 project and as a bundler project with the DOM library.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importEach, installedManifest, packInto, publicSubpaths, ROOT, typecheckConsumer } from '../support.mjs';

const STRICT = { strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, target: 'ES2023' };

const PROFILES = [
    {
        name: 'node16',
        testSupport: true,
        options: {
            ...STRICT,
            module: 'node16',
            moduleResolution: 'node16',
            lib: ['ES2023'],
            types: ['node'],
            typeRoots: [join(ROOT, 'node_modules', '@types')],
        },
        forbid: ['/lib.dom.d.ts'],
    },
    {
        name: 'bundler',
        testSupport: false,
        options: {
            ...STRICT,
            module: 'preserve',
            moduleResolution: 'bundler',
            lib: ['ES2023', 'DOM', 'DOM.Iterable'],
            types: [],
        },
        forbid: ['/@types/node/'],
    },
];

const scratch = mkdtempSync(join(tmpdir(), 'foundation-node-'));

try {
    const tarball = packInto(scratch);
    const consumer = join(scratch, 'consumer');

    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: 'module', private: true }));
    execFileSync(
        'npm',
        ['install', '--offline', '--no-save', '--no-audit', '--no-fund', '--no-package-lock', tarball],
        { cwd: consumer, stdio: 'inherit' },
    );
    // test-support needs vitest, which an offline install cannot fetch.
    symlinkSync(join(ROOT, 'node_modules', 'vitest'), join(consumer, 'node_modules', 'vitest'), 'dir');

    const manifest = installedManifest(consumer);
    const runtime = publicSubpaths(manifest, { testSupport: false });

    importEach(consumer, runtime);
    console.log(`node: imported ${runtime.length} subpaths.`);

    for (const { name, testSupport, options, forbid } of PROFILES) {
        const subpaths = publicSubpaths(manifest, { testSupport });
        const { files } = typecheckConsumer({ dir: consumer, subpaths, options, forbid });

        console.log(`${name}: type-checked ${subpaths.length} subpaths across ${files} files.`);
    }
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
