/**
 * React Native smoke check for the packed package.
 *
 * Installs the packed tarball into this fixture, then for iOS and Android
 * bundles every public subpath with Metro under React Native's defaults,
 * compiles the bundle to Hermes bytecode and evaluates it in a context holding
 * only the web APIs React Native provides. Finally it requires every subpath
 * under React Native's Jest preset.
 *
 * Hermes only compiles here, since no Hermes VM is published, and the context
 * approximates React Native's globals; runtime behaviour is the unit suite's
 * job. Test-support subpaths are skipped because they need the test runner.
 *
 * Usage: `npm run smoke:react-native` from the repository root.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const FIXTURE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(FIXTURE, '..', '..');
const GENERATED = join(FIXTURE, 'generated');
const PACKAGE = '@sinemacula/foundation';
const PLATFORMS = ['ios', 'android'];

const HERMESC = {
    darwin: 'osx-bin/hermesc',
    linux: 'linux64-bin/hermesc',
    win32: 'win64-bin/hermesc.exe',
};

const REACT_NATIVE_GLOBALS = [
    'AbortController',
    'AbortSignal',
    'Blob',
    'FormData',
    'URL',
    'URLSearchParams',
    'WebSocket',
    'clearInterval',
    'clearTimeout',
    'console',
    'fetch',
    'queueMicrotask',
    'setInterval',
    'setTimeout',
];

/** A smoke-check failure. */
class SmokeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SmokeError';
    }
}

const fixtureRequire = createRequire(join(FIXTURE, 'package.json'));
const reactNativeRequire = createRequire(fixtureRequire.resolve('react-native'));

/** Pack the package into `scratch` and install the tarball into the fixture. */
function installPackedPackage(scratch) {
    execFileSync('npm', ['pack', '--silent', '--pack-destination', scratch], { cwd: ROOT, stdio: 'inherit' });

    const tarball = readdirSync(scratch).find(file => file.endsWith('.tgz'));

    execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', join(scratch, tarball)], {
        cwd: FIXTURE,
        stdio: 'inherit',
    });
}

/** The installed package's public subpaths, minus the test-support entries. */
function publicSubpaths() {
    const manifest = JSON.parse(readFileSync(join(FIXTURE, 'node_modules', PACKAGE, 'package.json'), 'utf8'));
    const subpaths = Object.keys(manifest.exports).map(key => `${PACKAGE}/${key.slice(2)}`);
    const skipped = subpaths.filter(subpath => subpath.includes('/test-support/'));

    console.log(`Skipping test-support subpaths: ${skipped.join(', ')}`);

    return subpaths.filter(subpath => !skipped.includes(subpath));
}

/** Write the Metro entry and the Jest test that load every subpath. */
function writeEntries(subpaths) {
    rmSync(GENERATED, { recursive: true, force: true });
    mkdirSync(GENERATED);

    const names = subpaths.map((_, index) => `module${index}`);
    const imports = subpaths.map((subpath, index) => `import * as ${names[index]} from '${subpath}';`);
    const tally = `globalThis.loadedSubpaths = [${names.join(', ')}].filter(module => typeof module === 'object').length;`;

    writeFileSync(join(GENERATED, 'entry.js'), `${[...imports, tally].join('\n')}\n`);
    writeFileSync(
        join(GENERATED, 'load.test.js'),
        `test.each(${JSON.stringify(subpaths)})('loads %s', subpath => {\n` +
            `    expect(typeof require(subpath)).toBe('object');\n});\n`,
    );
}

/** Bundle the entry for one platform with React Native's Metro defaults. */
async function bundle(platform, out) {
    const { loadConfig, runBuild } = createRequire(reactNativeRequire.resolve('@react-native/community-cli-plugin'))(
        'metro',
    );
    const { getDefaultConfig } = fixtureRequire('@react-native/metro-config');
    const config = await loadConfig({ cwd: FIXTURE }, getDefaultConfig(FIXTURE));

    await runBuild(config, { entry: join(GENERATED, 'entry.js'), platform, out, dev: false, minify: false });
}

/** Compile a bundle to Hermes bytecode, failing on syntax Hermes rejects. */
function compile(bundlePath) {
    const hermesc = join(dirname(reactNativeRequire.resolve('hermes-compiler')), 'hermesc', HERMESC[process.platform]);

    execFileSync(hermesc, ['-emit-binary', '-O', '-w', '-out', `${bundlePath}.hbc`, bundlePath], { stdio: 'inherit' });
}

/** Evaluate a bundle against React Native's globals and count the loaded subpaths. */
function evaluate(bundlePath) {
    const context = createContext(Object.fromEntries(REACT_NATIVE_GLOBALS.map(name => [name, globalThis[name]])));

    runInContext(readFileSync(bundlePath, 'utf8'), context, { filename: bundlePath });

    return context.loadedSubpaths;
}

/** Require every subpath under React Native's Jest preset. */
async function runJest() {
    const { runCLI } = fixtureRequire('jest');
    const config = {
        preset: '@react-native/jest-preset',
        rootDir: FIXTURE,
        roots: ['<rootDir>/generated'],
        transform: {
            '^.+\\.js$': [
                'babel-jest',
                { configFile: false, babelrc: false, presets: [fixtureRequire.resolve('@react-native/babel-preset')] },
            ],
        },
        transformIgnorePatterns: [`/node_modules/(?!(@react-native|react-native|${PACKAGE})/)`],
    };
    const { results } = await runCLI({ config: JSON.stringify(config), runInBand: true }, [FIXTURE]);

    if (!results.success) {
        throw new SmokeError('A subpath failed to load under the React Native Jest preset.');
    }
}

const scratch = mkdtempSync(join(tmpdir(), 'foundation-react-native-'));

try {
    installPackedPackage(scratch);

    const subpaths = publicSubpaths();

    writeEntries(subpaths);

    for (const platform of PLATFORMS) {
        const out = join(scratch, `${platform}.js`);

        await bundle(platform, out);
        compile(out);

        const loaded = evaluate(out);

        if (loaded !== subpaths.length) {
            throw new SmokeError(`${platform}: loaded ${loaded} of ${subpaths.length} subpaths.`);
        }

        console.log(`${platform}: bundled, compiled to Hermes bytecode and loaded ${loaded} subpaths.`);
    }

    await runJest();
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
