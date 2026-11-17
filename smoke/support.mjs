/**
 * What the packed-package smokes share: packing, installing, listing the public
 * subpaths, importing each under plain Node and type-checking a consumer that
 * imports them all.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE = '@sinemacula/foundation';

// Evaluated code resolves bare specifiers from the working directory.
const IMPORT_EACH = [
    'for (const subpath of process.argv.slice(1)) {',
    '    await import(subpath).catch(error => {',
    "        throw new Error('Failed to import ' + subpath + '.', { cause: error });",
    '    });',
    '}',
].join('\n');

/** A smoke-check failure. */
export class SmokeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SmokeError';
    }
}

/** Pack the package into `scratch` and return the tarball's path. */
export function packInto(scratch) {
    execFileSync('npm', ['pack', '--silent', '--pack-destination', scratch], {
        cwd: ROOT,
        stdio: ['ignore', 'ignore', 'inherit'],
    });

    return join(
        scratch,
        readdirSync(scratch).find(file => file.endsWith('.tgz')),
    );
}

/** The manifest of the package as installed under `dir`. */
export function installedManifest(dir) {
    return JSON.parse(readFileSync(join(dir, 'node_modules', PACKAGE, 'package.json'), 'utf8'));
}

/**
 * The manifest's export subpaths as specifiers, with or without test-support,
 * which needs a test runner.
 */
export function publicSubpaths(manifest, { testSupport }) {
    return Object.keys(manifest.exports)
        .map(key => `${PACKAGE}/${key.slice(2)}`)
        .filter(subpath => testSupport || !subpath.includes('/test-support/'));
}

/**
 * Import every subpath with plain Node from `dir`, in a child process with no
 * loader, failing on the first that rejects.
 */
export function importEach(dir, subpaths) {
    execFileSync(process.execPath, ['--input-type=module', '--eval', IMPORT_EACH, ...subpaths], {
        cwd: dir,
        stdio: 'inherit',
    });
}

/** The real path of a file, with forward slashes. */
function canonical(path) {
    return realpathSync(path).split(sep).join('/');
}

/** The real root of the package `name` as Node resolves it from `dir`. */
function packageRoot(dir, name) {
    const candidate = join(dir, 'node_modules', name);

    if (existsSync(candidate)) {
        return `${canonical(candidate)}/`;
    }

    if (dirname(dir) === dir) {
        throw new SmokeError(`No ${name} package is installed above ${dir}.`);
    }

    return packageRoot(dirname(dir), name);
}

/**
 * Type-check a consumer in `dir` that imports every subpath, with `options` in
 * tsconfig form. Every diagnostic fails it except those inside a package named
 * in `tolerate`, and so does loading any file whose path contains a `forbid`
 * entry.
 *
 * @returns how many files the program loaded and how many diagnostics it
 * tolerated
 */
export function typecheckConsumer({ dir, subpaths, options, forbid = [], tolerate = [] }) {
    const file = join(dir, 'consumer.ts');
    const names = subpaths.map((_, index) => `m${index}`);

    writeFileSync(
        file,
        `${subpaths.map((subpath, index) => `import * as ${names[index]} from '${subpath}';`).join('\n')}\n` +
            `export const all = [${names.join(', ')}];\n`,
    );

    const parsed = ts.convertCompilerOptionsFromJson({ ...options, noEmit: true }, dir);
    const compilerHost = ts.createCompilerHost(parsed.options);

    // Type libraries resolve from the consumer's directory, not the process's.
    compilerHost.getCurrentDirectory = () => dir;

    const program = ts.createProgram([file], parsed.options, compilerHost);
    const tolerated = tolerate.map(name => packageRoot(dir, name));
    const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
    const failures = diagnostics.filter(
        diagnostic =>
            diagnostic.file === undefined ||
            !tolerated.some(root => canonical(diagnostic.file.fileName).startsWith(root)),
    );
    const loaded = program
        .getSourceFiles()
        .map(source => canonical(source.fileName))
        .filter(name => forbid.some(pattern => name.includes(pattern)));

    if (failures.length > 0 || loaded.length > 0) {
        const host = { getCanonicalFileName: name => name, getCurrentDirectory: () => dir, getNewLine: () => '\n' };

        throw new SmokeError(
            `${ts.formatDiagnostics(failures, host)}${loaded.map(name => `Forbidden file loaded: ${name}\n`).join('')}`,
        );
    }

    return { files: program.getSourceFiles().length, tolerated: diagnostics.length - failures.length };
}
