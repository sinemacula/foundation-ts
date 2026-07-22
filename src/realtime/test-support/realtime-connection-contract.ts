/**
 * Shared RealtimeConnection lifecycle contract.
 *
 * The EventSource and WebSocket adapters implement the same
 * {@link RealtimeConnection} port and must exhibit identical lifecycle
 * behaviour. That shared behaviour is asserted once here and driven by each
 * suite through a small transport harness, so the two adapters cannot drift.
 * Transport-specific behaviour (SSE data coercion, the WebSocket envelope and
 * send, the default-factory branches) stays in each adapter's own suite.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExponentialBackoff } from '../exponential-backoff';
import type { RealtimeConnection } from '../realtime-connection';

/** The contract-relevant construction options a harness forwards to its adapter. */
export interface ContractConnectionOptions {
    /** The endpoint URL, or a function resolved on every connect. */
    readonly url: string | (() => string);

    /** The backoff strategy spacing reconnect attempts. */
    readonly backoff?: ExponentialBackoff;

    /** Optional hook awaited before each reconnect attempt. */
    readonly beforeReconnect?: () => Promise<void>;
}

/** One fake transport, adapted to a transport-agnostic surface. */
export interface ContractTransport {
    /** The URL the transport was opened with. */
    readonly url: string;

    /** How many times the transport was closed. */
    readonly closeCalls: number;

    /** Simulate the transport opening. */
    readonly open: () => void;

    /** Simulate the transport failing (an SSE error or a WebSocket close). */
    readonly fail: () => void;

    /** Simulate an incoming message for a named event. */
    readonly message: (event: string, data: string) => void;
}

/** A live view of the transports created so far; grows as reconnects open more. */
export interface ContractTransportRegistry {
    /** The number of transports created. */
    readonly length: number;

    /** The transport at the given index, or undefined when out of range. */
    readonly at: (index: number) => ContractTransport | undefined;
}

/** The adapter-specific hooks the contract is parameterised by. */
export interface RealtimeContractHarness {
    /**
     * Construct the adapter with a recording factory injected.
     *
     * @param options - the contract-relevant construction options
     * @returns the connection under test and its live transport registry
     */
    create(options: ContractConnectionOptions): {
        /** The connection under test. */
        connection: RealtimeConnection;

        /** The transports the adapter has opened, in creation order. */
        transports: ContractTransportRegistry;
    };
}

/** Fixed-delay backoff for deterministic reconnect assertions. */
function fixedBackoff(delay: number): ExponentialBackoff {
    return new ExponentialBackoff({ initialDelay: delay, multiplier: 1, maxDelay: delay });
}

/** A promise plus its externally callable settlement functions. */
interface Deferred<T> {
    /** The controlled promise. */
    readonly promise: Promise<T>;

    /** Settle the promise successfully. */
    readonly resolve: (value: T) => void;

    /** Settle the promise with a rejection. */
    readonly reject: (reason: unknown) => void;
}

/** Creates a promise whose settlement is controlled from the test body. */
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
 * Assert the shared RealtimeConnection lifecycle contract against one adapter.
 *
 * @param harness - the adapter-specific transport harness
 */
export function describeRealtimeContract(harness: RealtimeContractHarness): void {
    describe('RealtimeConnection contract', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        describe('initial state', () => {
            it('starts in the idle state', () => {
                const { connection } = harness.create({ url: 'realtime://test' });

                expect(connection.state).toBe('idle');
            });
        });

        describe('connect()', () => {
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

            it('uses a default ExponentialBackoff when none is provided', () => {
                const { connection, transports } = harness.create({ url: 'realtime://test' });

                connection.connect();
                transports.at(0)?.fail();

                // Default backoff: first attempt delay is 1 000 ms.
                vi.advanceTimersByTime(999);
                expect(transports).toHaveLength(1);

                vi.advanceTimersByTime(1);
                expect(transports).toHaveLength(2);
            });
        });

        describe('disconnect()', () => {
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

            it('cancels a pending reconnect timer', () => {
                const { connection, transports } = harness.create({ url: 'realtime://test', backoff: fixedBackoff(500) });

                connection.connect();
                transports.at(0)?.fail();

                // Reconnect is pending; disconnect before the timer fires.
                connection.disconnect();

                vi.advanceTimersByTime(1_000);

                // Still only the original transport - reconnect was cancelled.
                expect(transports).toHaveLength(1);
            });

            it('does not reconnect after disconnect', () => {
                const { connection, transports } = harness.create({ url: 'realtime://test', backoff: fixedBackoff(100) });

                connection.connect();
                connection.disconnect();

                vi.advanceTimersByTime(5_000);

                expect(transports).toHaveLength(1);
            });
        });

        describe('reconnect', () => {
            it('schedules a reconnect after a failure', () => {
                const { connection, transports } = harness.create({ url: 'realtime://test', backoff: fixedBackoff(200) });

                connection.connect();
                transports.at(0)?.fail();

                expect(transports).toHaveLength(1);

                vi.advanceTimersByTime(200);

                expect(transports).toHaveLength(2);
            });

            it('advances the backoff delay on successive failures', () => {
                const { connection, transports } = harness.create({
                    url: 'realtime://test',
                    backoff: new ExponentialBackoff({ initialDelay: 100, multiplier: 2, maxDelay: 10_000 }),
                });

                connection.connect();
                transports.at(0)?.fail();

                // attempt=0 -> 100 ms
                vi.advanceTimersByTime(100);
                expect(transports).toHaveLength(2);

                transports.at(1)?.fail();

                // attempt=1 -> 200 ms
                vi.advanceTimersByTime(199);
                expect(transports).toHaveLength(2);

                vi.advanceTimersByTime(1);
                expect(transports).toHaveLength(3);
            });

            it('resets the attempt counter after a successful open', () => {
                const { connection, transports } = harness.create({
                    url: 'realtime://test',
                    backoff: new ExponentialBackoff({ initialDelay: 100, multiplier: 2, maxDelay: 10_000 }),
                });

                connection.connect();
                // Fail twice to advance the attempt counter.
                transports.at(0)?.fail();
                vi.advanceTimersByTime(100);

                transports.at(1)?.fail();
                vi.advanceTimersByTime(200);

                // Now open successfully -> attempt resets.
                transports.at(2)?.open();

                transports.at(2)?.fail();

                // Next delay should be 100 ms again (attempt 0).
                vi.advanceTimersByTime(99);
                expect(transports).toHaveLength(3);

                vi.advanceTimersByTime(1);
                expect(transports).toHaveLength(4);
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
                const { connection, transports } = harness.create({ url: 'realtime://test', backoff: fixedBackoff(50) });

                const received: string[] = [];

                connection.on('update', msg => received.push(msg.data));
                connection.connect();
                transports.at(0)?.fail();

                vi.advanceTimersByTime(50);

                transports.at(1)?.open();
                transports.at(1)?.message('update', 'hello');

                expect(received).toEqual(['hello']);
            });
        });

        describe('beforeReconnect', () => {
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

                // Hook is pending: no second transport yet.
                expect(transports).toHaveLength(1);

                gate.resolve();
                await gate.promise;

                expect(transports).toHaveLength(2);
            });

            it('schedules the next backoff attempt without creating a transport when the hook rejects', async () => {
                let calls = 0;
                const { connection, transports } = harness.create({
                    url: 'realtime://test',
                    backoff: fixedBackoff(100),
                    beforeReconnect: () =>
                        ++calls === 1 ? Promise.reject(new Error('token refresh failed')) : Promise.resolve(),
                });

                connection.connect();
                transports.at(0)?.fail();

                await vi.advanceTimersByTimeAsync(100);

                // First hook call rejected: attempt abandoned, no transport
                // created.
                expect(transports).toHaveLength(1);
                expect(connection.state).toBe('connecting');

                await vi.advanceTimersByTimeAsync(100);

                // Next backoff attempt: hook resolves, transport is created.
                expect(transports).toHaveLength(2);
                expect(calls).toBe(2);
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

                // No further reconnect is ever scheduled.
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
                    // Rejection is expected here; the abandonment is asserted
                    // below.
                });

                expect(transports).toHaveLength(1);
                expect(connection.state).toBe('closed');

                await vi.advanceTimersByTimeAsync(10_000);

                expect(transports).toHaveLength(1);
                expect(connection.state).toBe('closed');
            });
        });

        describe('on()', () => {
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
        });

        describe('onStateChange()', () => {
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
                const { connection, transports } = harness.create({ url: 'realtime://test', backoff: fixedBackoff(50) });

                const states: string[] = [];

                connection.onStateChange(s => states.push(s));
                connection.connect();
                // Failure -> connecting again should not re-emit 'connecting'
                // when already connecting.
                transports.at(0)?.fail();

                expect(states).toEqual(['connecting']);
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
        });
    });
}
