/**
 * Registers a benchmark case that records a local baseline or compares against
 * one, as selected by the `BENCH_MODE` environment variable.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { BenchFn } from 'vitest';
import { test } from 'vitest';

const MODE = process.env['BENCH_MODE'];

/**
 * Map a test's full name to its baseline file under the gitignored build
 * directory.
 */
function baselinePath(fullName: string): string {
    const slug = fullName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

    return `build/bench/${slug}.json`;
}

/**
 * Benchmark `fn` as the test `name`, never asserting on its speed.
 */
export function measure(name: string, fn: BenchFn): void {
    test(name, async ({ bench, task }) => {
        const baseline = baselinePath(task.fullName);

        if (MODE === 'compare') {
            await bench.compare(bench('current', fn), bench.from('baseline', baseline));

            return;
        }

        await bench(name, MODE === 'baseline' ? { writeResult: baseline } : {}, fn).run();
    });
}
