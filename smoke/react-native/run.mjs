/**
 * Type-check every public subpath of the packed package as a React Native
 * project, bundle them with Metro for iOS and Android, compile each bundle to
 * Hermes bytecode and load it, then require each subpath under React Native's
 * Jest preset. Each run also executes the behaviour scenario, and its report
 * must match the one plain Node produces.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createContext, runInContext } from 'node:vm';

import { installedManifest, PACKAGE, packInto, publicSubpaths, SmokeError, typecheckConsumer } from '../support.mjs';

const FIXTURE = dirname(fileURLToPath(import.meta.url));
const GENERATED = join(FIXTURE, 'generated');
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

// The only diagnostics tolerated sit inside react-native's own generated types.
const REACT_NATIVE_TYPES = {
    options: {
        strict: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: false,
        target: 'ES2023',
        module: 'preserve',
        moduleResolution: 'bundler',
        customConditions: ['react-native'],
        lib: ['ES2023'],
        types: ['react-native'],
    },
    forbid: ['/lib.dom.d.ts', '/@types/node/'],
    tolerate: ['react-native'],
};

const fixtureRequire = createRequire(join(FIXTURE, 'package.json'));
const reactNativeRequire = createRequire(fixtureRequire.resolve('react-native'));

/** Pack the package into `scratch` and install the tarball into the fixture. */
function installPackedPackage(scratch) {
    execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', packInto(scratch)], {
        cwd: FIXTURE,
        stdio: 'inherit',
    });
}

/**
 * Write the Metro entry, which loads every subpath and starts the scenario, and
 * the Jest tests that require each subpath and rerun the scenario.
 */
function writeEntries(subpaths, report) {
    rmSync(GENERATED, { recursive: true, force: true });
    mkdirSync(GENERATED);

    const names = subpaths.map((_, index) => `module${index}`);
    const imports = subpaths.map((subpath, index) => `import * as ${names[index]} from '${subpath}';`);
    const tally = `globalThis.loadedSubpaths = [${names.join(', ')}].filter(module => typeof module === 'object').length;`;

    writeFileSync(
        join(GENERATED, 'entry.js'),
        `${[...imports, "import { runScenario } from '../scenario.js';", tally, 'globalThis.scenario = runScenario();'].join('\n')}\n`,
    );
    writeFileSync(
        join(GENERATED, 'load.test.js'),
        `test.each(${JSON.stringify(subpaths)})('loads %s', subpath => {\n` +
            `    expect(typeof require(subpath)).toBe('object');\n});\n`,
    );
    writeFileSync(
        join(GENERATED, 'behaviour.test.js'),
        "import { runScenario } from '../scenario.js';\n\n" +
            "test('runs the behaviour scenario as plain Node does', async () => {\n" +
            `    expect(JSON.parse(JSON.stringify(await runScenario()))).toEqual(${JSON.stringify(report)});\n});\n`,
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

/**
 * Evaluate a bundle in Node against React Native's globals, since no Hermes VM
 * is published, and return how many subpaths loaded and the scenario's report,
 * serialised so it carries no prototype from the bundle's realm.
 */
async function evaluate(bundlePath) {
    const context = createContext(Object.fromEntries(REACT_NATIVE_GLOBALS.map(name => [name, globalThis[name]])));

    runInContext(readFileSync(bundlePath, 'utf8'), context, { filename: bundlePath });

    return { loaded: context.loadedSubpaths, report: JSON.parse(JSON.stringify(await context.scenario)) };
}

/** Require every subpath and run the scenario under React Native's Jest preset. */
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
        throw new SmokeError('A subpath failed to load or the scenario diverged under the React Native Jest preset.');
    }
}

/** Type-check a consumer importing every subpath as a React Native project. */
function typecheck(subpaths) {
    mkdirSync(GENERATED, { recursive: true });

    const { files, tolerated } = typecheckConsumer({ dir: GENERATED, subpaths, ...REACT_NATIVE_TYPES });

    console.log(
        `react-native: type-checked ${subpaths.length} subpaths across ${files} files, ` +
            `tolerating ${tolerated} diagnostics inside react-native's own types.`,
    );
}

const scratch = mkdtempSync(join(tmpdir(), 'foundation-react-native-'));

try {
    installPackedPackage(scratch);

    const subpaths = publicSubpaths(installedManifest(FIXTURE), { testSupport: false });
    const { runScenario } = await import('./scenario.js');
    const report = await runScenario();

    console.log('node: ran the behaviour scenario.');
    typecheck(subpaths);
    writeEntries(subpaths, report);

    for (const platform of PLATFORMS) {
        const out = join(scratch, `${platform}.js`);

        await bundle(platform, out);
        compile(out);

        const evaluated = await evaluate(out);

        if (evaluated.loaded !== subpaths.length) {
            throw new SmokeError(`${platform}: loaded ${evaluated.loaded} of ${subpaths.length} subpaths.`);
        }

        if (!isDeepStrictEqual(evaluated.report, report)) {
            throw new SmokeError(
                `${platform}: the scenario reported ${JSON.stringify(evaluated.report)}, plain Node ${JSON.stringify(report)}.`,
            );
        }

        console.log(
            `${platform}: bundled, compiled to Hermes bytecode, loaded ${subpaths.length} subpaths and ran the scenario.`,
        );
    }

    await runJest();
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
