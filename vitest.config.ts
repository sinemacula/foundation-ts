/**
 * Vitest configuration: Node environment, 100% coverage of the source, mocks,
 * globals and env stubs restored after every test.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
        restoreMocks: true,
        unstubGlobals: true,
        unstubEnvs: true,
        benchmark: {
            include: ['bench/**/*.bench.ts'],
        },
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'lcov'],
            include: ['src/**/*.ts'],
            exclude: ['**/*.test.ts', '**/test-support/**', '**/*.d.ts'],
            thresholds: {
                lines: 100,
                functions: 100,
                branches: 100,
                statements: 100,
            },
        },
    },
});
