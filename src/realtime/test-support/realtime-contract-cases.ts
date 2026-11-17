/**
 * The RealtimeConnection contract cases, defined against an injected suite.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { expect, vi } from 'vitest';

import { ExponentialBackoff } from '../exponential-backoff';
import type { RealtimeConnection, RealtimeState } from '../realtime-connection';
import { RealtimeError } from '../realtime-error';
import type { ContractTransportRegistry, RealtimeContractHarness } from './realtime-connection-contract';

/** The test-definition functions the cases register through. */
export interface RealtimeContractSuite {
    /** Group the cases `body` defines under `name`. */
    readonly describe: (name: string, body: () => void) => void;

    /** Define one case. */
    readonly it: (name: string, body: () => void | Promise<void>) => void;
}

/** How many times a self-re-subscribing handler re-arms before giving up. */
const REARM_CAP = 10;

/** A promise plus its externally callable settlement functions. */
interface Deferred<T> {
    /** The controlled promise. */
    readonly promise: Promise<T>;

    /** Settle the promise successfully. */
    readonly resolve: (value: T) => void;

    /** Settle the promise with a rejection. */
    readonly reject: (reason: unknown) => void;
}

/** One way of feeding values to subscribers, shared by on() and onStateChange(). */
interface SubscriptionChannel {
    /** Subscribe a handler that ignores the value. */
    readonly subscribe: (connection: RealtimeConnection, handler: () => void) => () => void;

    /** Prepare the connection so the channel can emit. */
    readonly prepare: (connection: RealtimeConnection) => void;

    /** Emit the value at `index` (0 or 1) to the channel's subscribers. */
    readonly emit: (connection: RealtimeConnection, transports: ContractTransportRegistry, index: number) => void;
}

/** Message delivery through on('update'). */
const MESSAGE_CHANNEL: SubscriptionChannel = {
    subscribe: (connection, handler) => connection.on('update', handler),
    prepare: connection => connection.connect(),
    emit: (_connection, transports, index) => transports.at(0)?.message('update', `value-${index}`),
};

/** State delivery through onStateChange(): connecting, then open. */
const STATE_CHANNEL: SubscriptionChannel = {
    subscribe: (connection, handler) => connection.onStateChange(handler),
    prepare: () => undefined,
    emit: (connection, transports, index) => {
        if (index === 0) {
            connection.connect();
        } else {
            transports.at(0)?.open();
        }
    },
};

/**
 * Fixed-delay backoff for deterministic reconnect assertions.
 */
function fixedBackoff(delay: number): ExponentialBackoff {
    return new ExponentialBackoff({ initialDelay: delay, multiplier: 1, maxDelay: delay });
}

/**
 * Doubling backoff from 100 ms, so each attempt's delay is distinct.
 */
function doublingBackoff(): ExponentialBackoff {
    return new ExponentialBackoff({ initialDelay: 100, multiplier: 2, maxDelay: 10_000 });
}

/**
 * Create a promise whose settlement is controlled from the test body.
 */
function deferred<T = void>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;

    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

/**
 * Assert that the next transport is created exactly `delay` ms from now.
 */
function expectNextTransportAfter(transports: ContractTransportRegistry, delay: number): void {
    const before = transports.length;

    vi.advanceTimersByTime(delay - 1);
    expect(transports).toHaveLength(before);

    vi.advanceTimersByTime(1);
    expect(transports).toHaveLength(before + 1);
}

/** Where a transport fails to open. */
type OpenFailureSource = 'url builder' | 'transport factory';

/** Every source a transport can fail to open from. */
const OPEN_FAILURE_SOURCES: readonly OpenFailureSource[] = ['url builder', 'transport factory'];

/** Switches an open failure on and off at one source. */
interface OpenFailure {
    /** The url builder to construct the connection with. */
    readonly url: () => string;

    /** Bind the switch to the created connection's factory. */
    readonly bind: (created: Pick<Created, 'setFactoryError'>) => void;

    /** Make the source throw `error`, or stop it with null. */
    readonly set: (error: Error | null) => void;
}

/** What a harness's create() returns. */
type Created = ReturnType<RealtimeContractHarness['create']>;

/**
 * Create a switchable open failure at `source`.
 */
function openFailure(source: OpenFailureSource): OpenFailure {
    let urlError: Error | null = null;
    let bound: Pick<Created, 'setFactoryError'> | undefined;

    return {
        url: () => {
            if (urlError !== null) {
                throw urlError;
            }

            return 'realtime://test';
        },
        bind: created => {
            bound = created;
        },
        set: error => {
            if (source === 'url builder') {
                urlError = error;
            } else {
                bound?.setFactoryError(error);
            }
        },
    };
}

/** A failure thrown by a subscriber or an error sink on purpose. */
class SubscriberFailure extends Error {
    /**
     * Construct the failure.
     */
    constructor(message: string) {
        super(message);
        this.name = 'SubscriberFailure';
    }
}

/**
 * Define the registration and dispatch cases one channel must satisfy.
 */
function defineRegistrationCases(
    { it }: RealtimeContractSuite,
    harness: RealtimeContractHarness,
    channel: SubscriptionChannel,
): void {
    /**
     * Create a connection, prepared for the channel to emit.
     */
    function setup(onError?: (error: unknown) => void): {
        /** The connection under test. */
        connection: RealtimeConnection;

        /** Emit the value at `index` to the channel's subscribers. */
        emit: (index: number) => void;
    } {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            ...(onError === undefined ? {} : { onError }),
        });

        channel.prepare(connection);

        return { connection, emit: index => channel.emit(connection, transports, index) };
    }

    it('calls a handler registered twice once per registration', () => {
        const { connection, emit } = setup();
        const handler = vi.fn();

        channel.subscribe(connection, handler);
        channel.subscribe(connection, handler);
        emit(0);

        expect(handler).toHaveBeenCalledTimes(2);
    });

    it('removes only its own registration on unsubscribe', () => {
        const { connection, emit } = setup();
        const handler = vi.fn();
        const unsubscribe = channel.subscribe(connection, handler);

        channel.subscribe(connection, handler);
        unsubscribe();
        emit(0);

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('treats a repeated unsubscribe as a no-op', () => {
        const { connection, emit } = setup();
        const handler = vi.fn();
        const unsubscribe = channel.subscribe(connection, handler);

        channel.subscribe(connection, handler);
        unsubscribe();
        unsubscribe();
        emit(0);

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not deliver the in-flight value to a handler subscribed during dispatch', () => {
        const { connection, emit } = setup();
        const late = vi.fn();
        let subscribed = false;

        channel.subscribe(connection, () => {
            if (!subscribed) {
                subscribed = true;
                channel.subscribe(connection, late);
            }
        });
        emit(0);

        expect(late).not.toHaveBeenCalled();

        emit(1);

        expect(late).toHaveBeenCalledTimes(1);
    });

    it('skips a handler unsubscribed by an earlier handler during dispatch', () => {
        const { connection, emit } = setup();
        const later = vi.fn();
        let unsubscribeLater: (() => void) | undefined;

        channel.subscribe(connection, () => unsubscribeLater?.());
        unsubscribeLater = channel.subscribe(connection, later);
        emit(0);

        expect(later).not.toHaveBeenCalled();
    });

    it('delivers once per value to a handler that re-subscribes itself', () => {
        const { connection, emit } = setup();
        let deliveries = 0;
        let rearms = 0;

        /**
         * Subscribe a handler that replaces itself with a fresh one.
         */
        const arm = (): void => {
            const unsubscribe = channel.subscribe(connection, () => {
                deliveries++;
                unsubscribe();

                // The cap turns a live-iteration regression into a failure
                // rather than a hang.
                if (++rearms < REARM_CAP) {
                    arm();
                }
            });
        };

        arm();
        emit(0);

        expect(deliveries).toBe(1);

        emit(1);

        expect(deliveries).toBe(2);
    });

    it('delivers one value across two to a handler that unsubscribes itself', () => {
        const { connection, emit } = setup();
        let deliveries = 0;
        const unsubscribe = channel.subscribe(connection, () => {
            deliveries++;
            unsubscribe();
        });

        emit(0);
        emit(1);

        expect(deliveries).toBe(1);
    });

    it('routes a throwing handler to onError and still runs the rest', () => {
        const errors: unknown[] = [];
        const failure = new SubscriberFailure('subscriber exploded');
        const { connection, emit } = setup(error => errors.push(error));
        const after = vi.fn();

        channel.subscribe(connection, () => {
            throw failure;
        });
        channel.subscribe(connection, after);
        emit(0);

        expect(errors).toHaveLength(1);
        expect(errors[0]).toBe(failure);
        expect(after).toHaveBeenCalledTimes(1);
    });

    it('starves no handler when onError itself throws', () => {
        const { connection, emit } = setup(() => {
            throw new SubscriberFailure('sink exploded');
        });
        const after = vi.fn();

        channel.subscribe(connection, () => {
            throw new SubscriberFailure('subscriber exploded');
        });
        channel.subscribe(connection, after);
        emit(0);
        emit(1);

        expect(after).toHaveBeenCalledTimes(2);
    });
}

/**
 * Define the cases for the initial state.
 */
function defineInitialStateCases({ it }: RealtimeContractSuite, harness: RealtimeContractHarness): void {
    it('starts in the idle state', () => {
        const { connection } = harness.create({ url: 'realtime://test' });

        expect(connection.state).toBe('idle');
    });
}

/**
 * Define the cases for connect().
 */
function defineConnectCases({ it }: RealtimeContractSuite, harness: RealtimeContractHarness): void {
    it('transitions to connecting and creates a transport', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });

        connection.connect();

        expect(connection.state).toBe('connecting');
        expect(transports).toHaveLength(1);
    });

    it('passes the url string to the factory', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test/path' });

        connection.connect();

        expect(transports.at(0)?.url).toBe('realtime://test/path');
    });

    it('resolves a url function on each connect', () => {
        const token = 'token-a';
        const { connection, transports } = harness.create({ url: () => `realtime://test?t=${token}` });

        connection.connect();

        expect(transports.at(0)?.url).toBe('realtime://test?t=token-a');
    });

    it('is a no-op when already connecting', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });

        connection.connect();
        connection.connect();

        expect(transports).toHaveLength(1);
    });

    it('is a no-op when already open', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });

        connection.connect();
        transports.at(0)?.open();
        connection.connect();

        expect(transports).toHaveLength(1);
    });

    it('transitions to open when the transport opens', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });

        connection.connect();
        transports.at(0)?.open();

        expect(connection.state).toBe('open');
    });

    for (const source of OPEN_FAILURE_SOURCES) {
        it(`throws a RealtimeError carrying the cause and leaves the state unchanged while the ${source} throws`, () => {
            const cause = new Error('no token');
            const failure = openFailure(source);
            const created = harness.create({ url: failure.url });
            const { connection, transports } = created;
            const states: string[] = [];
            const thrown: unknown[] = [];

            failure.bind(created);
            failure.set(cause);
            connection.onStateChange(state => states.push(state));

            for (let call = 0; call < 2; call++) {
                try {
                    connection.connect();
                } catch (error) {
                    thrown.push(error);
                }
            }

            expect(thrown).toEqual([expect.any(RealtimeError), expect.any(RealtimeError)]);
            expect(thrown.map(error => (error as Error).cause)).toEqual([cause, cause]);
            expect(connection.state).toBe('idle');
            expect(states).toEqual([]);
            expect(transports).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);

            failure.set(null);
            connection.connect();

            expect(transports).toHaveLength(1);
            expect(connection.state).toBe('connecting');
        });
    }
}

/**
 * Define the cases for disconnect().
 */
function defineDisconnectCases({ it }: RealtimeContractSuite, harness: RealtimeContractHarness): void {
    it('transitions to closed', () => {
        const { connection } = harness.create({ url: 'realtime://test' });

        connection.connect();
        connection.disconnect();

        expect(connection.state).toBe('closed');
    });

    it('closes the underlying transport', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });

        connection.connect();
        connection.disconnect();

        expect(transports.at(0)?.closeCalls).toBe(1);
    });

    it('emits closed once when disconnected from idle', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });
        const states: RealtimeState[] = [];

        connection.onStateChange(state => states.push(state));
        connection.disconnect();
        connection.disconnect();

        expect(states).toEqual(['closed']);
        expect(transports).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels a pending reconnect timer', () => {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(500),
        });

        connection.connect();
        transports.at(0)?.fail();

        connection.disconnect();

        vi.advanceTimersByTime(1_000);

        expect(transports).toHaveLength(1);
    });

    it('does not reconnect after disconnect', () => {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(100),
        });

        connection.connect();
        connection.disconnect();

        vi.advanceTimersByTime(5_000);

        expect(transports).toHaveLength(1);
    });
}

/**
 * Define the cases for reconnecting.
 */
function defineReconnectCases({ it }: RealtimeContractSuite, harness: RealtimeContractHarness): void {
    it('schedules a reconnect after a failure', () => {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(200),
        });

        connection.connect();
        transports.at(0)?.fail();

        expect(transports).toHaveLength(1);

        vi.advanceTimersByTime(200);

        expect(transports).toHaveLength(2);
    });

    it('reconnects within the default first-attempt window when no backoff is given', () => {
        const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);

        try {
            const { connection, transports } = harness.create({ url: 'realtime://test' });

            connection.connect();
            transports.at(0)?.fail();

            vi.advanceTimersByTime(499);
            expect(transports).toHaveLength(1);

            vi.advanceTimersByTime(501);
            expect(transports).toHaveLength(2);
        } finally {
            random.mockRestore();
        }
    });

    it('advances the backoff delay on successive failures', () => {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: doublingBackoff(),
        });

        connection.connect();
        transports.at(0)?.fail();
        expectNextTransportAfter(transports, 100);

        transports.at(1)?.fail();
        expectNextTransportAfter(transports, 200);
    });

    it('does not reset the backoff for a transport that closes immediately after opening', () => {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: doublingBackoff(),
        });

        connection.connect();
        transports.at(0)?.fail();
        vi.advanceTimersByTime(100);

        transports.at(1)?.open();
        transports.at(1)?.fail();
        expectNextTransportAfter(transports, 200);

        transports.at(2)?.open();
        transports.at(2)?.fail();
        expectNextTransportAfter(transports, 400);
    });

    for (const [uptime, delay] of [
        [4_999, 400],
        [5_000, 100],
    ] as const) {
        it(`waits ${delay} ms after a transport that stayed open for ${uptime} ms`, () => {
            const { connection, transports } = harness.create({
                url: 'realtime://test',
                backoff: doublingBackoff(),
            });

            connection.connect();
            transports.at(0)?.fail();
            vi.advanceTimersByTime(100);
            transports.at(1)?.fail();
            vi.advanceTimersByTime(200);

            transports.at(2)?.open();
            vi.advanceTimersByTime(uptime);
            transports.at(2)?.fail();

            expectNextTransportAfter(transports, delay);
        });
    }

    it('does not carry a stable uptime over to a transport that never opened', () => {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: doublingBackoff(),
        });

        connection.connect();
        transports.at(0)?.open();
        vi.advanceTimersByTime(5_000);
        transports.at(0)?.fail();
        expectNextTransportAfter(transports, 100);

        transports.at(1)?.fail();
        expectNextTransportAfter(transports, 200);
    });

    it('does not carry an uptime from a transport released by disconnect into the next connection', () => {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: doublingBackoff(),
        });

        connection.connect();
        transports.at(0)?.open();
        vi.advanceTimersByTime(5_000);
        connection.disconnect();

        connection.connect();
        transports.at(1)?.fail();
        expectNextTransportAfter(transports, 100);

        transports.at(2)?.fail();
        expectNextTransportAfter(transports, 200);
    });

    it('holds the gap at maxDelay with one pending timer after 50 failures', () => {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: new ExponentialBackoff({ initialDelay: 10, multiplier: 2, maxDelay: 1_000 }),
        });

        connection.connect();

        for (let failure = 0; failure < 49; failure++) {
            transports.at(failure)?.fail();
            vi.advanceTimersToNextTimer();
        }

        transports.at(49)?.fail();

        expect(vi.getTimerCount()).toBe(1);
        expectNextTransportAfter(transports, 1_000);
    });

    it('restarts the backoff sequence after a disconnect', () => {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: doublingBackoff(),
        });

        connection.connect();
        transports.at(0)?.fail();
        vi.advanceTimersByTime(100);
        transports.at(1)?.fail();
        vi.advanceTimersByTime(200);
        transports.at(2)?.fail();

        connection.disconnect();
        connection.connect();
        transports.at(3)?.fail();

        expectNextTransportAfter(transports, 100);
    });

    it('uses the url function on each reconnect', () => {
        let counter = 0;
        const { connection, transports } = harness.create({
            url: () => `realtime://test?n=${++counter}`,
            backoff: fixedBackoff(50),
        });

        connection.connect();
        transports.at(0)?.fail();

        vi.advanceTimersByTime(50);

        expect(transports.at(0)?.url).toBe('realtime://test?n=1');
        expect(transports.at(1)?.url).toBe('realtime://test?n=2');
    });

    it('re-delivers to a subscription registered before connect after reconnect', () => {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(50),
        });
        const received: string[] = [];

        connection.on('update', msg => received.push(msg.data));
        connection.connect();
        transports.at(0)?.fail();

        vi.advanceTimersByTime(50);

        transports.at(1)?.open();
        transports.at(1)?.message('update', 'hello');

        expect(received).toEqual(['hello']);
    });

    it('delivers a subscription made after connect on the reconnected transport', () => {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(50),
        });
        const received: string[] = [];

        connection.connect();
        transports.at(0)?.open();
        connection.on('update', msg => received.push(msg.data));
        transports.at(0)?.fail();

        vi.advanceTimersByTime(50);

        transports.at(1)?.open();
        transports.at(1)?.message('update', 'hello');

        expect(received).toEqual(['hello']);
    });

    it('delivers a subscription made during the backoff exactly once after the transport reopens', () => {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(50),
        });
        const received: string[] = [];

        connection.connect();
        transports.at(0)?.open();
        transports.at(0)?.fail();
        connection.on('update', msg => received.push(msg.data));

        vi.advanceTimersByTime(50);

        transports.at(1)?.open();
        transports.at(1)?.message('update', 'hello');

        expect(received).toEqual(['hello']);
    });

    it('ignores events from a transport released by disconnect and connect', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });
        const received: string[] = [];

        connection.on('update', msg => received.push(msg.data));
        connection.connect();
        connection.disconnect();
        connection.connect();

        transports.at(0)?.open();
        transports.at(0)?.message('update', 'stale');
        transports.at(0)?.fail();

        expect(connection.state).toBe('connecting');
        expect(received).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);

        transports.at(1)?.open();
        transports.at(1)?.message('update', 'fresh');

        expect(connection.state).toBe('open');
        expect(received).toEqual(['fresh']);
    });

    for (const source of OPEN_FAILURE_SOURCES) {
        for (const sink of ['with', 'without']) {
            it(`reports a ${source} failure on reconnect once and reschedules ${sink} an onError sink`, () => {
                const cause = new Error('no token');
                const errors: unknown[] = [];
                const reported = sink === 'with' ? [cause] : [];
                const failure = openFailure(source);
                const created = harness.create({
                    url: failure.url,
                    backoff: doublingBackoff(),
                    ...(sink === 'with' ? { onError: (error: unknown) => errors.push(error) } : {}),
                });
                const { connection, transports } = created;

                failure.bind(created);
                connection.connect();
                transports.at(0)?.fail();
                failure.set(cause);

                vi.advanceTimersByTime(100);

                expect(errors).toEqual(reported);
                expect(transports).toHaveLength(1);
                expect(connection.state).toBe('connecting');
                expect(vi.getTimerCount()).toBe(1);

                failure.set(null);

                // The failed attempt advanced the backoff.
                expectNextTransportAfter(transports, 200);

                transports.at(1)?.open();

                expect(connection.state).toBe('open');
                expect(errors).toEqual(reported);
            });
        }
    }

    it('stops the rest of a message and leaves one live transport when a handler disconnects and connects', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });
        const later = vi.fn();
        let cycled = false;

        connection.on('update', () => {
            if (!cycled) {
                cycled = true;
                connection.disconnect();
                connection.connect();
            }
        });
        connection.on('update', later);
        connection.connect();
        transports.at(0)?.open();
        transports.at(0)?.message('update', 'x');

        expect(later).not.toHaveBeenCalled();
        expect(transports).toHaveLength(2);
        expect(transports.at(0)?.closeCalls).toBe(1);
        expect(transports.at(1)?.closeCalls).toBe(0);
        expect(connection.state).toBe('connecting');
        expect(vi.getTimerCount()).toBe(0);
    });
}

/**
 * Define the cases for the beforeReconnect hook.
 */
function defineBeforeReconnectCases({ it }: RealtimeContractSuite, harness: RealtimeContractHarness): void {
    it('is not invoked for the initial connect()', () => {
        const beforeReconnect = vi.fn(() => Promise.resolve());
        const { connection } = harness.create({ url: 'realtime://test', beforeReconnect });

        connection.connect();

        expect(beforeReconnect).not.toHaveBeenCalled();
    });

    it('is not invoked for a manual connect() call', () => {
        const beforeReconnect = vi.fn(() => Promise.resolve());
        const { connection, transports } = harness.create({ url: 'realtime://test', beforeReconnect });

        connection.connect();
        connection.disconnect();
        connection.connect();

        expect(beforeReconnect).not.toHaveBeenCalled();
        expect(transports).toHaveLength(2);
    });

    it('is invoked after the backoff delay fires, not immediately on failure', async () => {
        const beforeReconnect = vi.fn(() => Promise.resolve());
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(100),
            beforeReconnect,
        });

        connection.connect();
        transports.at(0)?.fail();

        expect(beforeReconnect).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(100);

        expect(beforeReconnect).toHaveBeenCalledTimes(1);
    });

    it('creates the new transport only after the hook resolves', async () => {
        const gate = deferred<void>();
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(100),
            beforeReconnect: () => gate.promise,
        });

        connection.connect();
        transports.at(0)?.fail();

        await vi.advanceTimersByTimeAsync(100);

        expect(transports).toHaveLength(1);

        gate.resolve();
        await gate.promise;

        expect(transports).toHaveLength(2);
    });

    it('resolves url() after beforeReconnect settles', async () => {
        const gate = deferred<void>();
        let token = 'before';
        const { connection, transports } = harness.create({
            url: () => `realtime://test?t=${token}`,
            backoff: fixedBackoff(100),
            beforeReconnect: async () => {
                await gate.promise;
                token = 'after';
            },
        });

        connection.connect();
        transports.at(0)?.fail();

        await vi.advanceTimersByTimeAsync(100);

        expect(transports).toHaveLength(1);

        gate.resolve();
        await vi.advanceTimersByTimeAsync(0);

        expect(transports.at(1)?.url).toBe('realtime://test?t=after');
    });

    it('passes a live signal to an undisturbed attempt', async () => {
        const signals: AbortSignal[] = [];
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(100),
            beforeReconnect: signal => {
                signals.push(signal);

                return Promise.resolve();
            },
        });

        connection.connect();
        transports.at(0)?.fail();

        await vi.advanceTimersByTimeAsync(100);
        transports.at(1)?.open();

        expect(signals).toHaveLength(1);
        expect(signals[0]?.aborted).toBe(false);
    });

    it('aborts the hook signal when disconnected while the hook is pending', async () => {
        const gate = deferred<void>();
        const signals: AbortSignal[] = [];
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(100),
            beforeReconnect: signal => {
                signals.push(signal);

                return gate.promise;
            },
        });

        connection.connect();
        transports.at(0)?.fail();

        await vi.advanceTimersByTimeAsync(100);

        expect(signals[0]?.aborted).toBe(false);

        connection.disconnect();

        expect(signals[0]?.aborted).toBe(true);

        gate.resolve();
        await vi.advanceTimersByTimeAsync(0);

        expect(transports).toHaveLength(1);
    });

    it('keeps a lifecycle started by a listener on the aborted hook signal', async () => {
        const signals: AbortSignal[] = [];
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(100),
            beforeReconnect: signal => {
                signals.push(signal);

                if (signals.length > 1) {
                    return Promise.resolve();
                }

                signal.addEventListener('abort', () => {
                    connection.disconnect();
                    connection.connect();
                });

                return deferred<void>().promise;
            },
        });

        connection.connect();
        transports.at(0)?.fail();
        await vi.advanceTimersByTimeAsync(100);

        connection.disconnect();

        expect(transports).toHaveLength(2);
        expect(transports.at(1)?.closeCalls).toBe(0);
        expect(connection.state).toBe('connecting');

        transports.at(1)?.fail();
        await vi.advanceTimersByTimeAsync(100);

        expect(signals.map(signal => signal.aborted)).toEqual([true, false]);
        expect(transports).toHaveLength(3);
    });

    it('schedules the next backoff attempt without creating a transport when the hook rejects', async () => {
        const beforeReconnect = vi.fn(() => Promise.resolve()).mockRejectedValueOnce(new Error('token refresh failed'));
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(100),
            beforeReconnect,
        });

        connection.connect();
        transports.at(0)?.fail();

        await vi.advanceTimersByTimeAsync(100);

        expect(transports).toHaveLength(1);
        expect(connection.state).toBe('connecting');

        await vi.advanceTimersByTimeAsync(100);

        expect(transports).toHaveLength(2);
        expect(beforeReconnect).toHaveBeenCalledTimes(2);
    });

    it('schedules the next backoff attempt without creating a transport when the hook resolves false', async () => {
        const beforeReconnect = vi.fn(() => Promise.resolve(true)).mockResolvedValueOnce(false);
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(100),
            beforeReconnect,
        });

        connection.connect();
        transports.at(0)?.fail();

        await vi.advanceTimersByTimeAsync(100);

        expect(transports).toHaveLength(1);
        expect(connection.state).toBe('connecting');
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(100);

        expect(beforeReconnect).toHaveBeenCalledTimes(2);
        expect(transports).toHaveLength(2);
    });

    it('does not create a transport when disconnected while the hook is pending and it resolves', async () => {
        const gate = deferred<void>();
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(100),
            beforeReconnect: () => gate.promise,
        });

        connection.connect();
        transports.at(0)?.fail();

        await vi.advanceTimersByTimeAsync(100);

        connection.disconnect();
        gate.resolve();
        await gate.promise;

        expect(transports).toHaveLength(1);
        expect(connection.state).toBe('closed');

        await vi.advanceTimersByTimeAsync(10_000);

        expect(transports).toHaveLength(1);
        expect(connection.state).toBe('closed');
    });

    it('does not schedule anything when disconnected while the hook is pending and it rejects', async () => {
        const gate = deferred<void>();
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(100),
            beforeReconnect: () => gate.promise,
        });

        connection.connect();
        transports.at(0)?.fail();

        await vi.advanceTimersByTimeAsync(100);

        connection.disconnect();
        gate.reject(new Error('token refresh failed'));
        await gate.promise.catch(() => {
            // The rejection is expected.
        });

        expect(transports).toHaveLength(1);
        expect(connection.state).toBe('closed');

        await vi.advanceTimersByTimeAsync(10_000);

        expect(transports).toHaveLength(1);
        expect(connection.state).toBe('closed');
    });

    it('does not reschedule when a stale hook rejects after a disconnect and fresh connect', async () => {
        const gate = deferred<void>();
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(100),
            beforeReconnect: () => gate.promise,
        });

        connection.connect();
        transports.at(0)?.fail();

        await vi.advanceTimersByTimeAsync(100);

        connection.disconnect();
        connection.connect();
        transports.at(1)?.open();

        gate.reject(new Error('token refresh failed'));
        await vi.advanceTimersByTimeAsync(0);

        expect(vi.getTimerCount()).toBe(0);
        expect(connection.state).toBe('open');

        await vi.advanceTimersByTimeAsync(10_000);

        expect(transports).toHaveLength(2);
        expect(transports.at(1)?.closeCalls).toBe(0);
    });

    it('leaves exactly one live transport and no pending timers after rapid disconnect and connect cycles', async () => {
        const gates: Deferred<void>[] = [];
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(100),
            beforeReconnect: () => {
                const gate = deferred<void>();

                gates.push(gate);

                return gate.promise;
            },
        });

        for (let cycle = 0; cycle < 3; cycle++) {
            connection.connect();
            transports.at(cycle)?.open();
            transports.at(cycle)?.fail();

            await vi.advanceTimersByTimeAsync(100);

            connection.disconnect();
        }

        connection.connect();
        transports.at(3)?.open();

        for (const gate of gates) {
            gate.resolve();
        }

        await vi.advanceTimersByTimeAsync(10_000);

        expect(gates).toHaveLength(3);
        expect(transports).toHaveLength(4);
        expect(transports.at(3)?.closeCalls).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(connection.state).toBe('open');
    });
}

/**
 * Define the cases for on().
 */
function defineOnCases(suite: RealtimeContractSuite, harness: RealtimeContractHarness): void {
    const { describe, it } = suite;

    it('delivers matching messages to the handler', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });
        const received: string[] = [];

        connection.on('ping', msg => received.push(msg.data));
        connection.connect();
        transports.at(0)?.message('ping', 'pong');

        expect(received).toEqual(['pong']);
    });

    it('includes the event name in the message', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });
        const events: string[] = [];

        connection.on('myEvent', msg => events.push(msg.event));
        connection.connect();
        transports.at(0)?.message('myEvent', 'data');

        expect(events).toEqual(['myEvent']);
    });

    it('delivers messages to multiple handlers for the same event', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });
        const a: string[] = [];
        const b: string[] = [];

        connection.on('update', msg => a.push(msg.data));
        connection.on('update', msg => b.push(msg.data));
        connection.connect();
        transports.at(0)?.message('update', 'x');

        expect(a).toEqual(['x']);
        expect(b).toEqual(['x']);
    });

    it('does not deliver messages for a different event', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });
        const received: string[] = [];

        connection.on('ping', msg => received.push(msg.data));
        connection.connect();
        transports.at(0)?.message('other', 'ignored');

        expect(received).toEqual([]);
    });

    it('stops the message for later handlers when a handler disconnects', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });
        const later = vi.fn();

        connection.on('update', () => connection.disconnect());
        connection.on('update', later);
        connection.connect();
        transports.at(0)?.open();
        transports.at(0)?.message('update', 'x');

        expect(later).not.toHaveBeenCalled();
        expect(connection.state).toBe('closed');
    });

    it('delivers once after re-subscribing to an event whose last handler left, across a reconnect', () => {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(50),
        });
        const received: string[] = [];

        connection.on('update', () => undefined)();
        connection.on('update', msg => received.push(msg.data));
        connection.connect();
        transports.at(0)?.open();
        transports.at(0)?.message('update', 'first');
        transports.at(0)?.fail();

        vi.advanceTimersByTime(50);

        transports.at(1)?.open();
        transports.at(1)?.message('update', 'second');

        expect(received).toEqual(['first', 'second']);
    });

    it('does not remove a newer handler when an old unsubscribe is repeated', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });
        const received: string[] = [];
        const unsubscribeOld = connection.on('update', () => undefined);

        unsubscribeOld();
        connection.on('update', msg => received.push(msg.data));
        unsubscribeOld();
        connection.connect();
        transports.at(0)?.message('update', 'x');

        expect(received).toEqual(['x']);
    });

    describe('unsubscribe', () => {
        it('stops delivery after unsubscribe is called', () => {
            const { connection, transports } = harness.create({ url: 'realtime://test' });
            const received: string[] = [];
            const unsub = connection.on('ping', msg => received.push(msg.data));

            connection.connect();
            transports.at(0)?.message('ping', 'first');
            unsub();
            transports.at(0)?.message('ping', 'second');

            expect(received).toEqual(['first']);
        });

        it('does not affect other handlers for the same event', () => {
            const { connection, transports } = harness.create({ url: 'realtime://test' });
            const a: string[] = [];
            const b: string[] = [];
            const unsubA = connection.on('evt', msg => a.push(msg.data));

            connection.on('evt', msg => b.push(msg.data));
            connection.connect();
            transports.at(0)?.message('evt', '1');
            unsubA();
            transports.at(0)?.message('evt', '2');

            expect(a).toEqual(['1']);
            expect(b).toEqual(['1', '2']);
        });
    });

    describe('registration and dispatch', () => {
        defineRegistrationCases(suite, harness, MESSAGE_CHANNEL);
    });
}

/**
 * Define the cases for onStateChange().
 */
function defineOnStateChangeCases(suite: RealtimeContractSuite, harness: RealtimeContractHarness): void {
    const { describe, it } = suite;

    it('notifies on state transitions', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });
        const states: string[] = [];

        connection.onStateChange(s => states.push(s));
        connection.connect();
        transports.at(0)?.open();
        connection.disconnect();

        expect(states).toEqual(['connecting', 'open', 'closed']);
    });

    it('does not emit duplicate states', () => {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(50),
        });
        const states: string[] = [];

        connection.onStateChange(s => states.push(s));
        connection.connect();
        transports.at(0)?.fail();

        expect(states).toEqual(['connecting']);
    });

    it('notifies connecting, open, connecting, open for one drop', () => {
        const { connection, transports } = harness.create({
            url: 'realtime://test',
            backoff: fixedBackoff(50),
        });
        const states: RealtimeState[] = [];

        connection.onStateChange(state => states.push(state));
        connection.connect();
        transports.at(0)?.open();
        transports.at(0)?.fail();
        vi.advanceTimersByTime(50);
        transports.at(1)?.open();

        expect(states).toEqual(['connecting', 'open', 'connecting', 'open']);
    });

    it('leaves one live transport and no timers when a closed handler calls connect()', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });
        const observed: RealtimeState[] = [];
        let reconnected = false;

        connection.onStateChange(state => {
            if (state === 'closed' && !reconnected) {
                reconnected = true;
                connection.connect();
            }
        });
        connection.onStateChange(state => observed.push(state));
        connection.connect();
        transports.at(0)?.open();
        connection.disconnect();

        expect(observed).toEqual(['connecting', 'open', 'closed', 'connecting']);
        expect(transports).toHaveLength(2);
        expect(transports.at(0)?.closeCalls).toBe(1);
        expect(transports.at(1)?.closeCalls).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(connection.state).toBe('connecting');
    });

    it('delivers nested transitions in order after the current one', () => {
        const { connection, transports } = harness.create({ url: 'realtime://test' });
        const log: string[] = [];
        let disconnected = false;
        let reconnected = false;
        let unsubscribeC: (() => void) | undefined;

        connection.onStateChange(state => {
            log.push(`a:${state}`);

            if (state === 'open' && !disconnected) {
                disconnected = true;
                connection.disconnect();
                connection.onStateChange(next => log.push(`d:${next}`));
            }
        });
        connection.onStateChange(state => {
            log.push(`b:${state}`);

            if (state === 'open') {
                unsubscribeC?.();
            }

            if (state === 'closed' && !reconnected) {
                reconnected = true;
                connection.connect();
            }
        });
        unsubscribeC = connection.onStateChange(state => log.push(`c:${state}`));
        connection.connect();
        transports.at(0)?.open();

        expect(log).toEqual([
            'a:connecting',
            'b:connecting',
            'c:connecting',
            'a:open',
            'b:open',
            'a:closed',
            'b:closed',
            'a:connecting',
            'b:connecting',
            'd:connecting',
        ]);
    });

    describe('unsubscribe', () => {
        it('stops state notifications after unsubscribe', () => {
            const { connection, transports } = harness.create({ url: 'realtime://test' });
            const states: string[] = [];
            const unsub = connection.onStateChange(s => states.push(s));

            connection.connect();
            unsub();
            transports.at(0)?.open();

            expect(states).toEqual(['connecting']);
        });
    });

    describe('registration and dispatch', () => {
        defineRegistrationCases(suite, harness, STATE_CHANNEL);
    });
}

/**
 * Define the shared RealtimeConnection lifecycle contract on `suite`.
 *
 * Cases use fake timers, which the caller installs around each one.
 */
export function defineRealtimeContractCases(suite: RealtimeContractSuite, harness: RealtimeContractHarness): void {
    suite.describe('initial state', () => defineInitialStateCases(suite, harness));
    suite.describe('connect()', () => defineConnectCases(suite, harness));
    suite.describe('disconnect()', () => defineDisconnectCases(suite, harness));
    suite.describe('reconnect', () => defineReconnectCases(suite, harness));
    suite.describe('beforeReconnect', () => defineBeforeReconnectCases(suite, harness));
    suite.describe('on()', () => defineOnCases(suite, harness));
    suite.describe('onStateChange()', () => defineOnStateChangeCases(suite, harness));
}
