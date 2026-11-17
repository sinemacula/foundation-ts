/**
 * ConnectivityMonitor contract, run against every adapter of the port.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import type { ConnectivityMonitor } from '../connectivity-monitor';

/** A monitor under test and the platform it observes. */
export interface ConnectivityMonitorFixture {
    /** The monitor under test. */
    readonly monitor: ConnectivityMonitor;

    /** Set the platform's connectivity, emitting the platform's event to whatever is listening. */
    readonly report: (online: boolean) => void;
}

/** The adapter-specific hooks the contract is parameterised by. */
export interface ConnectivityMonitorContractHarness {
    /**
     * Build a monitor over a platform at the given connectivity.
     */
    create(initial: boolean): ConnectivityMonitorFixture;
}

/**
 * Assert the shared ConnectivityMonitor contract against one adapter.
 *
 * @param harness - the adapter-specific platform harness
 */
export function describeConnectivityMonitorContract(harness: ConnectivityMonitorContractHarness): void {
    describe('ConnectivityMonitor contract', () => {
        it.each([true, false])('starts at the platform connectivity %s', initial => {
            expect(harness.create(initial).monitor.online).toBe(initial);
        });

        it('observes nothing before it starts, then resamples the platform as it starts', () => {
            const { monitor, report } = harness.create(true);
            const handler = vi.fn();
            monitor.onChange(handler);

            report(false);

            expect(handler).not.toHaveBeenCalled();

            monitor.start();

            expect(monitor.online).toBe(false);
            expect(handler.mock.calls).toStrictEqual([[false]]);
        });

        it('notifies every handler once per change, with the state already updated', () => {
            const { monitor, report } = harness.create(true);
            const seen: Array<[string, boolean, boolean]> = [];
            monitor.onChange(online => seen.push(['first', online, monitor.online]));
            monitor.onChange(online => seen.push(['second', online, monitor.online]));
            monitor.start();

            report(false);
            report(true);

            expect(seen).toStrictEqual([
                ['first', false, false],
                ['second', false, false],
                ['first', true, true],
                ['second', true, true],
            ]);
        });

        it('notifies once for a repeated report', () => {
            const { monitor, report } = harness.create(true);
            const handler = vi.fn();
            monitor.onChange(handler);
            monitor.start();

            report(false);
            report(false);

            expect(handler.mock.calls).toStrictEqual([[false]]);
        });

        it('observes once when started twice', () => {
            const { monitor, report } = harness.create(true);
            const handler = vi.fn();
            monitor.onChange(handler);
            monitor.start();
            monitor.start();

            report(false);

            expect(handler.mock.calls).toStrictEqual([[false]]);
        });

        it('stops observing, idempotently', () => {
            const { monitor, report } = harness.create(true);
            const handler = vi.fn();
            monitor.onChange(handler);
            monitor.start();

            monitor.stop();
            monitor.stop();
            report(false);

            expect(handler).not.toHaveBeenCalled();
            expect(monitor.online).toBe(true);
        });

        it.each([
            ['notifies once for a change', [false], [[false]]],
            ['stays quiet for a change undone', [false, true], []],
        ] as const)('resamples on restart and %s made while stopped', (_label, reports, calls) => {
            const { monitor, report } = harness.create(true);
            const handler = vi.fn();
            monitor.onChange(handler);
            monitor.start();
            monitor.stop();

            for (const online of reports) {
                report(online);
            }

            monitor.start();

            expect(monitor.online).toBe(reports.at(-1));
            expect(handler.mock.calls).toStrictEqual(calls);
        });

        it('stops notifying only the handler that unsubscribed', () => {
            const { monitor, report } = harness.create(true);
            const kept = vi.fn();
            const dropped = vi.fn();
            monitor.onChange(kept);
            const unsubscribe = monitor.onChange(dropped);
            monitor.start();

            unsubscribe();
            report(false);

            expect(kept.mock.calls).toStrictEqual([[false]]);
            expect(dropped).not.toHaveBeenCalled();
        });
    });
}
