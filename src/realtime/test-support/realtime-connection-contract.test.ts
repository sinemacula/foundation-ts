/**
 * Proves the realtime contract passes a correct adapter and fails broken ones.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import { ExponentialBackoff } from '../exponential-backoff';
import type { RealtimeConnection, RealtimeMessageHandler } from '../realtime-connection';
import { createWebSocketContractHarness } from './fake-web-socket';
import type {
    ContractConnectionOptions,
    ContractTransportRegistry,
    RealtimeContractHarness,
} from './realtime-connection-contract';
import { defineRealtimeContractCases } from './realtime-contract-cases';

/** One collected contract case. */
interface ContractCase {
    /** The case's full name, its describe path joined by ' > '. */
    readonly name: string;

    /** The case body. */
    readonly body: () => void | Promise<void>;
}

/** What a harness's create() returns. */
type Created = ReturnType<RealtimeContractHarness['create']>;

/**
 * Collect the contract cases for `harness` without registering them.
 */
function collectCases(harness: RealtimeContractHarness): ContractCase[] {
    const cases: ContractCase[] = [];
    const path: string[] = [];

    defineRealtimeContractCases(
        {
            describe: (name, body) => {
                path.push(name);
                body();
                path.pop();
            },
            it: (name, body) => {
                cases.push({ name: [...path, name].join(' > '), body });
            },
        },
        harness,
    );

    return cases;
}

/**
 * Run every contract case against `harness` under fake timers.
 *
 * @returns the full names of the failing cases
 */
async function failingCases(harness: RealtimeContractHarness): Promise<string[]> {
    const failures: string[] = [];

    for (const { name, body } of collectCases(harness)) {
        vi.useFakeTimers();

        try {
            await body();
        } catch {
            failures.push(name);
        } finally {
            vi.useRealTimers();
            vi.restoreAllMocks();
        }
    }

    return failures;
}

/**
 * Wrap the reference harness, letting a test rewrite the options or result.
 */
function brokenHarness(
    rewrite: (options: ContractConnectionOptions, create: (options: ContractConnectionOptions) => Created) => Created,
): RealtimeContractHarness {
    const reference = createWebSocketContractHarness();

    return { create: options => rewrite(options, next => reference.create(next)) };
}

/**
 * Delegate every member of `inner`, overriding the given ones.
 */
function wrapConnection(inner: RealtimeConnection, overrides: Partial<RealtimeConnection>): RealtimeConnection {
    return {
        get state() {
            return inner.state;
        },
        connect: () => inner.connect(),
        disconnect: () => inner.disconnect(),
        on: (event, handler) => inner.on(event, handler),
        onStateChange: handler => inner.onStateChange(handler),
        ...overrides,
    };
}

/**
 * Rebases the attempt count at the first delay after an open, as an adapter
 * that resets its backoff on open would.
 */
class ResetOnOpenBackoff extends ExponentialBackoff {
    /** The backoff the delays come from. */
    readonly #inner: ExponentialBackoff;

    /** The attempt the sequence was rebased at. */
    #base: number = 0;

    /** Whether a transport opened since the last delay. */
    opened: boolean = false;

    /**
     * Wrap the backoff the delays come from.
     */
    constructor(inner: ExponentialBackoff) {
        super();
        this.#inner = inner;
    }

    /**
     * Compute the delay relative to the attempt at the last open.
     */
    override delayFor(attempt: number): number {
        if (this.opened) {
            this.opened = false;
            this.#base = attempt;
        }

        return this.#inner.delayFor(attempt - this.#base);
    }
}

/**
 * Forward messages on a released transport to the newest one.
 */
function ignoringOwnership(transports: ContractTransportRegistry): ContractTransportRegistry {
    return {
        get length() {
            return transports.length;
        },
        at: index => {
            const transport = transports.at(index);
            const newest = transports.at(transports.length - 1);

            if (transport === undefined || newest === undefined || transport.closeCalls === 0) {
                return transport;
            }

            return { ...transport, message: (event, data) => newest.message(event, data) };
        },
    };
}

/** Broken adapters and the cases each must fail. */
const BROKEN: [string, RealtimeContractHarness, string[]][] = [
    [
        'reconnects on a 0 ms timer after disconnect',
        brokenHarness((options, create) => {
            const created = create(options);
            const { connection } = created;

            return {
                ...created,
                connection: wrapConnection(connection, {
                    disconnect: () => {
                        connection.disconnect();
                        setTimeout(() => connection.connect(), 0);
                    },
                }),
            };
        }),
        ['disconnect() > does not reconnect after disconnect'],
    ],
    [
        'caches the url function',
        brokenHarness((options, create) => {
            const { url } = options;
            let cached: string | undefined;

            return create({ ...options, url: typeof url === 'string' ? url : () => (cached ??= url()) });
        }),
        [
            'reconnect > uses the url function on each reconnect',
            'beforeReconnect > resolves url() after beforeReconnect settles',
        ],
    ],
    [
        'does not await beforeReconnect',
        brokenHarness((options, create) => {
            const { beforeReconnect } = options;

            return create({
                ...options,
                ...(beforeReconnect === undefined
                    ? {}
                    : {
                          beforeReconnect: signal => {
                              void beforeReconnect(signal).catch(() => undefined);

                              return Promise.resolve();
                          },
                      }),
            });
        }),
        ['beforeReconnect > creates the new transport only after the hook resolves'],
    ],
    [
        'emits each state twice',
        brokenHarness((options, create) => {
            const created = create(options);
            const { connection } = created;

            return {
                ...created,
                connection: wrapConnection(connection, {
                    onStateChange: handler =>
                        connection.onStateChange(state => {
                            handler(state);
                            handler(state);
                        }),
                }),
            };
        }),
        ['onStateChange() > does not emit duplicate states'],
    ],
    [
        'keeps a live, deduplicating handler set',
        brokenHarness((options, create) => {
            const created = create(options);
            const { connection } = created;
            const handlers = new Map<string, Set<RealtimeMessageHandler>>();

            return {
                ...created,
                connection: wrapConnection(connection, {
                    on: (event, handler) => {
                        let set = handlers.get(event);

                        if (set === undefined) {
                            const live = new Set<RealtimeMessageHandler>();

                            set = live;
                            handlers.set(event, live);
                            connection.on(event, message => {
                                for (const next of live) {
                                    next(message);
                                }
                            });
                        }

                        set.add(handler);

                        return () => set.delete(handler);
                    },
                }),
            };
        }),
        [
            'on() > registration and dispatch > calls a handler registered twice once per registration',
            'on() > registration and dispatch > delivers once per value to a handler that re-subscribes itself',
        ],
    ],
    [
        'resets the backoff on open',
        brokenHarness((options, create) => {
            const backoff = new ResetOnOpenBackoff(options.backoff ?? new ExponentialBackoff());
            const created = create({ ...options, backoff });

            created.connection.onStateChange(state => {
                backoff.opened ||= state === 'open';
            });

            return created;
        }),
        ['reconnect > does not reset the backoff for a transport that closes immediately after opening'],
    ],
    [
        'ignores transport ownership',
        brokenHarness((options, create) => {
            const created = create(options);

            return { ...created, transports: ignoringOwnership(created.transports) };
        }),
        ['reconnect > ignores events from a transport released by disconnect and connect'],
    ],
];

describe('RealtimeConnection contract cases', () => {
    const names = collectCases(createWebSocketContractHarness()).map(({ name }) => name);

    it('collects uniquely named cases', () => {
        expect(names.length).toBeGreaterThan(0);
        expect(new Set(names).size).toBe(names.length);
    });

    it('names every sentinel case', () => {
        expect(names).toEqual(expect.arrayContaining(BROKEN.flatMap(([, , sentinels]) => sentinels)));
    });

    it('passes the reference adapter', async () => {
        await expect(failingCases(createWebSocketContractHarness())).resolves.toEqual([]);
    });

    it.each(BROKEN)('fails an adapter that %s', async (_label, harness, sentinels) => {
        await expect(failingCases(harness)).resolves.toEqual(expect.arrayContaining(sentinels));
    });
});
