/**
 * Tests for ConfirmedConnectivityMonitor: its contract, confirmation windows,
 * probe scheduling and lifecycle.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { getEventListeners } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfirmedConnectivityMonitorOptions, ReachabilityProbe } from './confirmed-connectivity-monitor';
import { ConfirmedConnectivityMonitor } from './confirmed-connectivity-monitor';
import type { ConnectivityHandler, ConnectivityMonitor } from './connectivity-monitor';
import { describeConnectivityMonitorContract } from './test-support/connectivity-monitor-contract';

/** A platform signal driven by the test. */
class FakePlatform implements ConnectivityMonitor {
    /** The platform's connectivity. */
    online: boolean;

    /** Whether the platform is observed. */
    started: boolean = false;

    /** How many times the platform was started and stopped. */
    readonly calls = { start: 0, stop: 0 };

    /** The subscribed handlers. */
    readonly #handlers = new Set<ConnectivityHandler>();

    /**
     * Construct a platform at a connectivity.
     */
    constructor(online: boolean) {
        this.online = online;
    }

    /**
     * Mark the platform observed.
     */
    start(): void {
        this.started = true;
        this.calls.start++;
    }

    /**
     * Mark the platform unobserved.
     */
    stop(): void {
        this.started = false;
        this.calls.stop++;
    }

    /**
     * Subscribe a handler.
     */
    onChange(handler: ConnectivityHandler): () => void {
        this.#handlers.add(handler);

        return () => {
            this.#handlers.delete(handler);
        };
    }

    /**
     * Change the connectivity, notifying the handlers while observed.
     */
    report(online: boolean): void {
        this.online = online;

        if (this.started) {
            for (const handler of this.#handlers) {
                handler(online);
            }
        }
    }
}

/**
 * Build a monitor over a fake platform and a probe answering `reachable`.
 */
function build(initial: boolean, options: Partial<ConfirmedConnectivityMonitorOptions> = {}) {
    const platform = new FakePlatform(initial);
    const state = { reachable: initial };
    const probe = vi.fn<ReachabilityProbe>(() => Promise.resolve(state.reachable));
    const changes: boolean[] = [];
    const monitor = new ConfirmedConnectivityMonitor({
        platform,
        probe,
        now: () => Date.now(),
        recoveryBackoff: { delayFor: () => 10_000 },
        ...options,
    });

    monitor.onChange(online => changes.push(online));

    return { monitor, platform, probe, state, changes };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describeConnectivityMonitorContract({
    create: initial => {
        const { monitor, platform, state } = build(initial);

        return {
            monitor,
            report: online => {
                state.reachable = online;
                platform.report(online);
            },
        };
    },
    settle: async () => {
        await vi.advanceTimersByTimeAsync(60_000);
    },
});

describe('ConfirmedConnectivityMonitor', () => {
    it('goes offline only once failures span the offline window', async () => {
        const { monitor, state, changes } = build(true);
        monitor.start();
        await vi.advanceTimersByTimeAsync(0);

        state.reachable = false;
        monitor.hint(false);
        await vi.advanceTimersByTimeAsync(5_999);

        expect(changes).toStrictEqual([]);
        expect(monitor.online).toBe(true);

        await vi.advanceTimersByTimeAsync(1);

        expect(changes).toStrictEqual([false]);
        expect(monitor.online).toBe(false);
    });

    it('comes back online only once successes span the online window', async () => {
        const { monitor, state, changes } = build(false, { onlineAfter: 3_000 });
        monitor.start();
        await vi.advanceTimersByTimeAsync(0);

        state.reachable = true;
        monitor.hint(true);
        await vi.advanceTimersByTimeAsync(2_999);

        expect(changes).toStrictEqual([]);

        await vi.advanceTimersByTimeAsync(1_500);

        expect(changes).toStrictEqual([true]);
    });

    it('needs two results even with no window', async () => {
        const { monitor, probe, state, changes } = build(true, { offlineAfter: 0 });
        monitor.start();
        await vi.advanceTimersByTimeAsync(0);

        state.reachable = false;
        monitor.hint(false);
        await vi.advanceTimersByTimeAsync(0);

        expect(changes).toStrictEqual([]);

        await vi.advanceTimersByTimeAsync(1_500);

        expect(probe).toHaveBeenCalledTimes(3);
        expect(changes).toStrictEqual([false]);
    });

    it('keeps its state while results alternate', async () => {
        const { monitor, state, changes } = build(true);
        monitor.start();
        await vi.advanceTimersByTimeAsync(0);

        for (let cycle = 0; cycle < 10; cycle++) {
            state.reachable = cycle % 2 === 1;
            monitor.hint(state.reachable);
            await vi.advanceTimersByTimeAsync(3_000);
        }

        expect(changes).toStrictEqual([]);
    });

    it('stays offline through short recoveries between longer outages', async () => {
        const { monitor, state, changes } = build(true);
        monitor.start();
        await vi.advanceTimersByTimeAsync(0);

        for (let cycle = 0; cycle < 5; cycle++) {
            state.reachable = false;
            monitor.hint(false);
            await vi.advanceTimersByTimeAsync(6_000);
            state.reachable = true;
            monitor.hint(true);
            await vi.advanceTimersByTimeAsync(4_000);
        }

        expect(changes).toStrictEqual([false]);
    });

    it('does not come back online on one success followed by a hanging probe', async () => {
        const { monitor, probe, changes } = build(false);
        monitor.start();
        await vi.advanceTimersByTimeAsync(0);

        probe.mockResolvedValueOnce(true).mockImplementation(() => new Promise<boolean>(() => undefined));
        monitor.hint(true);
        await vi.advanceTimersByTimeAsync(5_000 + 1_500 + 5_000);

        expect(changes).toStrictEqual([]);
        expect(monitor.online).toBe(false);
    });

    it('counts a probe that outlives its timeout as unreachable, aborting its signal', async () => {
        const { monitor, probe, changes } = build(true, { probeTimeout: 1_000, offlineAfter: 1_000 });
        const signals: AbortSignal[] = [];
        probe.mockImplementation(signal => {
            signals.push(signal);

            return new Promise<boolean>(() => undefined);
        });

        monitor.start();
        await vi.advanceTimersByTimeAsync(999);

        expect(signals[0]?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);

        expect(signals[0]?.aborted).toBe(true);

        await vi.advanceTimersByTimeAsync(2_500);

        expect(changes).toStrictEqual([false]);
    });

    it.each([
        ['a rejection', () => Promise.reject(new Error('down'))],
        [
            'a synchronous throw',
            () => {
                throw new Error('down');
            },
        ],
        ['a non-true result', () => Promise.resolve('yes' as unknown as boolean)],
    ] as const)('counts %s as unreachable', async (_label, answer) => {
        const { monitor, probe, changes } = build(true);
        probe.mockImplementation(answer);

        monitor.start();
        await vi.advanceTimersByTimeAsync(6_000);

        expect(changes).toStrictEqual([false]);
    });

    it('runs one probe at a time, coalescing hints', async () => {
        const { monitor, probe } = build(true);
        const finishers: Array<(reachable: boolean) => void> = [];
        probe.mockImplementation(
            () =>
                new Promise<boolean>(resolve => {
                    finishers.push(resolve);
                }),
        );

        monitor.start();
        monitor.hint(false);
        monitor.hint(false);

        expect(probe).toHaveBeenCalledTimes(1);

        finishers[0]?.(true);
        await vi.advanceTimersByTimeAsync(0);

        expect(probe).toHaveBeenCalledTimes(1);
    });

    it('ignores a hint that agrees, one while confirming, and any while stopped', async () => {
        const { monitor, probe, state } = build(true);
        monitor.hint(false);

        expect(probe).not.toHaveBeenCalled();

        monitor.start();
        await vi.advanceTimersByTimeAsync(0);
        monitor.hint(true);

        expect(probe).toHaveBeenCalledTimes(1);

        state.reachable = false;
        monitor.hint(false);
        await vi.advanceTimersByTimeAsync(0);
        monitor.hint(false);

        expect(probe).toHaveBeenCalledTimes(2);
    });

    it('takes platform changes as hints and ignores them when stopped', async () => {
        const { monitor, platform, probe } = build(true);
        monitor.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(platform.started).toBe(true);

        platform.report(false);

        expect(probe).toHaveBeenCalledTimes(2);

        monitor.stop();
        platform.started = true;
        platform.report(true);
        platform.report(false);

        expect(probe).toHaveBeenCalledTimes(2);
    });

    it('starts and stops the platform signal once each, however often it is asked', () => {
        const { monitor, platform } = build(true);
        monitor.start();
        monitor.start();
        monitor.stop();
        monitor.stop();

        expect(platform.calls).toStrictEqual({ start: 1, stop: 1 });
    });

    it('can be started again by a listener of the probe it aborts', async () => {
        const { monitor, platform, probe } = build(true);
        let restarted = false;
        probe.mockImplementationOnce(signal => {
            signal.addEventListener('abort', () => {
                if (!restarted) {
                    restarted = true;
                    monitor.start();
                }
            });

            return new Promise<boolean>(() => undefined);
        });

        monitor.start();
        monitor.stop();

        expect(platform.started).toBe(true);
        expect(probe).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(0);
        platform.report(false);

        expect(probe).toHaveBeenCalledTimes(3);
    });

    it('cancels the scheduled probe when a hint probes early', async () => {
        const { monitor, probe } = build(true);
        monitor.start();
        await vi.advanceTimersByTimeAsync(10_000);
        monitor.hint(false);
        await vi.advanceTimersByTimeAsync(20_000);

        expect(probe).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(10_000);

        expect(probe).toHaveBeenCalledTimes(3);
    });

    it('releases the probe timeout and abort listener once a probe settles', async () => {
        const { monitor, probe } = build(true, { heartbeatInterval: Number.POSITIVE_INFINITY });
        monitor.start();
        await vi.advanceTimersByTimeAsync(0);

        const signal = probe.mock.calls[0]?.[0];

        expect(vi.getTimerCount()).toBe(0);
        expect(signal === undefined ? [] : getEventListeners(signal, 'abort')).toStrictEqual([]);
    });

    it('finds a silent loss on the heartbeat', async () => {
        const { monitor, state, changes } = build(true);
        monitor.start();
        await vi.advanceTimersByTimeAsync(0);

        state.reachable = false;
        await vi.advanceTimersByTimeAsync(29_999);

        expect(changes).toStrictEqual([]);

        await vi.advanceTimersByTimeAsync(1 + 6_000);

        expect(changes).toStrictEqual([false]);
    });

    it('schedules nothing while online with the heartbeat disabled', async () => {
        const { monitor, probe } = build(true, { heartbeatInterval: Number.POSITIVE_INFINITY });
        monitor.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(probe).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('spaces recovery probes on the backoff and restarts it on a recovery hint', async () => {
        const delayFor = vi.fn(() => 10_000);
        const { monitor, probe } = build(false, { recoveryBackoff: { delayFor } });
        monitor.start();
        await vi.advanceTimersByTimeAsync(20_000);

        expect(probe).toHaveBeenCalledTimes(3);
        expect(delayFor.mock.calls).toStrictEqual([[0], [1], [2]]);

        monitor.hint(true);
        await vi.advanceTimersByTimeAsync(0);

        expect(probe).toHaveBeenCalledTimes(4);
        expect(delayFor.mock.calls.at(-1)).toStrictEqual([0]);
    });

    it('restarts the recovery backoff on going offline', async () => {
        const delayFor = vi.fn(() => 10_000);
        const { monitor, state } = build(true, { recoveryBackoff: { delayFor } });
        state.reachable = false;
        monitor.start();
        await vi.advanceTimersByTimeAsync(6_000);

        expect(delayFor.mock.calls).toStrictEqual([[0]]);
    });

    it('starts a run again when its results are further apart than a probe cycle', async () => {
        let skew = 0;
        const { monitor, state, changes } = build(true, { now: () => Date.now() + skew });
        monitor.start();
        await vi.advanceTimersByTimeAsync(0);

        state.reachable = false;
        monitor.hint(false);
        await vi.advanceTimersByTimeAsync(0);
        skew = 20_000;
        await vi.advanceTimersByTimeAsync(6_000);

        expect(changes).toStrictEqual([]);

        await vi.advanceTimersByTimeAsync(1_500);

        expect(changes).toStrictEqual([false]);
    });

    it('continues a run whose results are exactly a probe cycle apart', async () => {
        let skew = 0;
        const { monitor, state, changes } = build(true, { now: () => Date.now() + skew });
        monitor.start();
        await vi.advanceTimersByTimeAsync(0);

        state.reachable = false;
        monitor.hint(false);
        await vi.advanceTimersByTimeAsync(0);
        skew = 2 * (1_500 + 5_000) - 1_500;
        await vi.advanceTimersByTimeAsync(1_500);

        expect(changes).toStrictEqual([false]);
    });

    it('ignores a probe that completes after a stop and restart', async () => {
        const { monitor, probe, changes } = build(true, { offlineAfter: 0 });
        const finishers: Array<(reachable: boolean) => void> = [];
        probe.mockImplementation(
            () =>
                new Promise<boolean>(resolve => {
                    finishers.push(resolve);
                }),
        );

        monitor.start();
        monitor.stop();
        monitor.start();
        finishers[0]?.(false);
        await vi.advanceTimersByTimeAsync(1_500);

        expect(probe).toHaveBeenCalledTimes(2);

        finishers[1]?.(false);
        await vi.advanceTimersByTimeAsync(0);

        expect(changes).toStrictEqual([]);
    });

    it('aborts the probe in flight and discards an unconfirmed change on stop', async () => {
        const { monitor, probe, state, changes } = build(true);
        monitor.start();
        await vi.advanceTimersByTimeAsync(0);

        state.reachable = false;
        monitor.hint(false);
        await vi.advanceTimersByTimeAsync(4_500);

        let signal: AbortSignal | undefined;
        probe.mockImplementationOnce(received => {
            signal = received;

            return new Promise<boolean>(() => undefined);
        });
        await vi.advanceTimersByTimeAsync(1_500);
        monitor.stop();

        expect(signal?.aborted).toBe(true);

        monitor.start();
        await vi.advanceTimersByTimeAsync(4_500);

        expect(changes).toStrictEqual([]);

        await vi.advanceTimersByTimeAsync(1_500);

        expect(changes).toStrictEqual([false]);
    });

    it('schedules nothing more when a subscriber stops it', async () => {
        const { monitor, probe, state } = build(true);
        monitor.onChange(() => {
            monitor.stop();
        });
        state.reachable = false;
        monitor.start();
        await vi.advanceTimersByTimeAsync(6_000);
        const calls = probe.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60_000);

        expect(probe).toHaveBeenCalledTimes(calls);
    });

    it('keeps one probe cycle when a subscriber hints on a change', async () => {
        const { monitor, probe, state } = build(true);
        monitor.onChange(() => {
            monitor.hint(true);
        });
        state.reachable = false;
        monitor.start();
        await vi.advanceTimersByTimeAsync(6_000);

        expect(probe).toHaveBeenCalledTimes(6);

        await vi.advanceTimersByTimeAsync(10_000);

        expect(probe).toHaveBeenCalledTimes(7);
    });

    it('reports a throwing subscriber and still notifies the rest', async () => {
        const onError = vi.fn();
        const { monitor, state, changes } = build(true, { onError });
        const error = new Error('handler');
        monitor.onChange(() => {
            throw error;
        });
        const after = vi.fn();
        monitor.onChange(after);

        state.reachable = false;
        monitor.start();
        await vi.advanceTimersByTimeAsync(6_000);

        expect(onError).toHaveBeenCalledWith(error);
        expect(changes).toStrictEqual([false]);
        expect(after).toHaveBeenCalledWith(false);
    });

    it('ignores a throwing subscriber without an error sink', async () => {
        const { monitor, state, changes } = build(true);
        monitor.onChange(() => {
            throw new Error('handler');
        });
        state.reachable = false;
        monitor.start();
        await vi.advanceTimersByTimeAsync(6_000);

        expect(changes).toStrictEqual([false]);
    });

    it('reports a throwing backoff and falls back to the heartbeat', async () => {
        const error = new Error('backoff');
        const onError = vi.fn(() => {
            throw new Error('sink');
        });
        const { monitor, probe } = build(false, {
            onError,
            recoveryBackoff: {
                delayFor: () => {
                    throw error;
                },
            },
        });
        monitor.start();
        await vi.advanceTimersByTimeAsync(29_999);

        expect(onError).toHaveBeenCalledWith(error);
        expect(probe).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);

        expect(probe).toHaveBeenCalledTimes(2);
    });

    it('schedules nothing when the error sink stops it', async () => {
        const { monitor, probe } = build(false, {
            onError: () => {
                monitor.stop();
            },
            recoveryBackoff: {
                delayFor: () => {
                    throw new Error('backoff');
                },
            },
        });
        monitor.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(vi.getTimerCount()).toBe(0);
        expect(probe).toHaveBeenCalledTimes(1);
    });

    it('stops listening to a handler that unsubscribed', async () => {
        const { monitor, state } = build(true);
        const handler = vi.fn();
        const unsubscribe = monitor.onChange(handler);
        unsubscribe();
        state.reachable = false;
        monitor.start();
        await vi.advanceTimersByTimeAsync(6_000);

        expect(handler).not.toHaveBeenCalled();
    });

    it('reads the monotonic clock by default and backs off within two seconds', async () => {
        const now = vi.spyOn(performance, 'now').mockReturnValue(0);
        const random = vi.spyOn(Math, 'random').mockReturnValue(0);
        const platform = new FakePlatform(false);
        const probe = vi.fn<ReachabilityProbe>(() => Promise.resolve(false));
        const monitor = new ConfirmedConnectivityMonitor({ platform, probe });

        monitor.start();
        await vi.advanceTimersByTimeAsync(999);

        expect(probe).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);

        expect(probe).toHaveBeenCalledTimes(2);
        expect(now).toHaveBeenCalled();
        expect(random).toHaveBeenCalled();
    });

    it('accepts zero for every duration', () => {
        expect(() =>
            build(true, { offlineAfter: 0, onlineAfter: 0, probeInterval: 0, probeTimeout: 0, heartbeatInterval: 0 }),
        ).not.toThrow();
    });

    it.each([
        ['offlineAfter', -1, 'a number of at least 0'],
        ['onlineAfter', Number.NaN, 'a number of at least 0'],
        ['heartbeatInterval', -1, 'a number of at least 0'],
        ['probeInterval', Number.POSITIVE_INFINITY, 'a finite number of at least 0'],
        ['probeTimeout', -1, 'a finite number of at least 0'],
    ] as const)('rejects a %s of %s', (name, value, rule) => {
        expect(() => build(true, { [name]: value } as Partial<ConfirmedConnectivityMonitorOptions>)).toThrow(
            new RangeError(`The connectivity ${name} must be ${rule}, got ${String(value)}.`),
        );
    });
});
