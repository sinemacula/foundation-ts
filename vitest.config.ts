/**
 * Vitest test-runner configuration.
 *
 * The base package is framework- and DOM-free, so tests run under the Node
 * environment. Coverage spans the whole TypeScript surface at 100%.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'lcov'],
            include: ['src/**/*.ts'],
            exclude: ['**/*.test.ts', '**/test-support/**', '**/*.d.ts'],
            thresholds: {
                lines: 100,
                functions: 100,
                branches: 100,
                statements: 100
            }
        }
    }
});
