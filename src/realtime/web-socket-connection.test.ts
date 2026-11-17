/**
 * Unit tests for web-socket-connection.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExponentialBackoff } from './exponential-backoff';
import { describeRealtimeContract, type RealtimeContractHarness } from './test-support/realtime-connection-contract';
import { WebSocketConnection, type WebSocketFactory } from './web-socket-connection';

/** Minimal fake WebSocket for injection via the factory. */
class FakeWebSocket {
    /** The URL the socket was opened with. */
    readonly url: string;

    /** The subprotocol(s) the socket was opened with. */
    readonly protocols: string | readonly string[] | undefined;

    /** The open handler the connection installs. */
    onopen: ((event: Event) => void) | null = null;

    /** The message handler the connection installs. */
    onmessage: ((event: MessageEvent) => void) | null = null;

    /** The close handler the connection installs. */
    onclose: ((event: CloseEvent) => void) | null = null;

    /** How many times close() was called. */
    closeCalls: number = 0;

    /** Every frame passed to send(), in order. */
    sentMessages: string[] = [];

    /**
     * Record the construction arguments.
     */
    constructor(url: string, protocols?: string | readonly string[]) {
        this.url = url;
        this.protocols = protocols;
    }

    /**
     * Record an outbound frame.
     */
    send(data: string): void {
        this.sentMessages.push(data);
    }

    /**
     * Record a close call.
     */
    close(): void {
        this.closeCalls++;
    }

    /**
     * Simulate the socket opening.
     */
    emitOpen(): void {
        this.onopen?.(new Event('open'));
    }

    /**
     * Simulate an incoming text frame.
     */
    emitMessage(data: string): void {
        this.onmessage?.(new MessageEvent('message', { data }));
    }

    /**
     * Simulate the socket closing.
     */
    emitClose(): void {
        // CloseEvent is only a global from node 23, and the handler ignores it.
        this.onclose?.(new Event('close') as CloseEvent);
    }
}

/** A recording factory and the fakes it has created so far. */
interface RecordingFactory {
    /** Every fake socket created, in order. */
    readonly sockets: FakeWebSocket[];

    /** The factory to inject into the connection. */
    readonly factory: WebSocketFactory;

    /** While true, the factory throws instead of creating a socket. */
    failing: boolean;
}

/**
 * Create a {@link WebSocketFactory} that records each fake socket it creates.
 */
function makeFactory(): RecordingFactory {
    const recording: RecordingFactory = {
        sockets: [],
        factory: (url, protocols) => {
            if (recording.failing) {
                throw new Error('factory failed');
            }

            const socket = new FakeWebSocket(url, protocols);

            recording.sockets.push(socket);

            return socket as unknown as WebSocket;
        },
        failing: false,
    };

    return recording;
}

/**
 * Backoff that waits `delay` milliseconds before every attempt.
 */
function fixedBackoff(delay: number): ExponentialBackoff {
    return new ExponentialBackoff({ initialDelay: delay, multiplier: 1, maxDelay: delay });
}

/** Adapts the WebSocket adapter and its fake to the shared realtime contract. */
function makeWsContractHarness(): RealtimeContractHarness {
    return {
        create(options) {
            const { sockets, factory } = makeFactory();
            const connection = new WebSocketConnection({ ...options, webSocketFactory: factory });

            return {
                connection,
                transports: {
                    get length() {
                        return sockets.length;
                    },
                    at(index) {
                        const socket = sockets.at(index);

                        if (socket === undefined) {
                            return undefined;
                        }

                        return {
                            get url() {
                                return socket.url;
                            },
                            get closeCalls() {
                                return socket.closeCalls;
                            },
                            open: () => socket.emitOpen(),
                            fail: () => socket.emitClose(),
                            message: (event, data) => socket.emitMessage(JSON.stringify({ event, data })),
                        };
                    },
                },
            };
        },
    };
}

/**
 * Replace the global WebSocket with a recorder capturing constructor calls.
 *
 * @returns the argument list of every construction, in order
 */
function stubGlobalWebSocket(): unknown[][] {
    const calls: unknown[][] = [];

    /** Records every construction instead of opening a socket. */
    class RecordingWebSocket {
        /**
         * Record the construction arguments.
         */
        constructor(...args: unknown[]) {
            calls.push(args);
        }
    }

    vi.stubGlobal('WebSocket', RecordingWebSocket);

    return calls;
}

describeRealtimeContract(makeWsContractHarness());

describe('WebSocketConnection', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    describe('connect()', () => {
        it('passes protocols to the factory', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', protocols: 'v1', webSocketFactory: factory });

            conn.connect();

            const socket = sockets.at(0);

            expect(socket).toBeDefined();
            expect(socket?.protocols).toBe('v1');
        });

        it('omits protocols from the platform WebSocket when none are set', () => {
            const calls = stubGlobalWebSocket();
            const conn = new WebSocketConnection({ url: 'ws://localhost' });

            conn.connect();

            expect(calls).toEqual([['ws://localhost']]);
        });

        it('passes a string protocol to the platform WebSocket', () => {
            const calls = stubGlobalWebSocket();
            const conn = new WebSocketConnection({ url: 'ws://localhost', protocols: 'v1' });

            conn.connect();

            expect(calls).toEqual([['ws://localhost', 'v1']]);
        });

        it('passes a protocols array to the platform WebSocket', () => {
            const calls = stubGlobalWebSocket();
            const conn = new WebSocketConnection({ url: 'ws://localhost', protocols: ['v1', 'v2'] });

            conn.connect();

            expect(calls).toEqual([['ws://localhost', ['v1', 'v2']]]);
        });
    });

    describe('on()', () => {
        it('delivers the raw frame to message subscribers', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const received: string[] = [];

            conn.on('message', msg => received.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage('hello');

            expect(received).toEqual(['hello']);
        });

        it('labels a raw frame with the message event', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const events: string[] = [];

            conn.on('message', msg => events.push(msg.event));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage('data');

            expect(events).toEqual(['message']);
        });

        it('keeps delivering to remaining message subscribers when one throws', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const received: string[] = [];
            const updates: string[] = [];

            conn.on('message', () => {
                throw new Error('subscriber exploded');
            });
            conn.on('message', msg => received.push(msg.data));
            conn.on('update', msg => updates.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage(JSON.stringify({ event: 'update', data: 'payload' }));

            expect(received).toEqual([JSON.stringify({ event: 'update', data: 'payload' })]);
            expect(updates).toEqual(['payload']);
        });

        it('keeps notifying remaining state subscribers when one throws', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const states: string[] = [];

            conn.onStateChange(() => {
                throw new Error('subscriber exploded');
            });
            conn.onStateChange(state => states.push(state));
            conn.connect();
            sockets.at(0)?.emitOpen();

            expect(states).toEqual(['connecting', 'open']);
        });

        it('delivers an envelope to message and named-event subscribers', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const messages: string[] = [];
            const updates: string[] = [];

            conn.on('message', msg => messages.push(msg.data));
            conn.on('update', msg => updates.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage(JSON.stringify({ event: 'update', data: 'payload' }));

            expect(messages).toEqual([JSON.stringify({ event: 'update', data: 'payload' })]);
            expect(updates).toEqual(['payload']);
        });

        it('stringifies non-string envelope data', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const received: string[] = [];

            conn.on('tick', msg => received.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage(JSON.stringify({ event: 'tick', data: { value: 42 } }));

            expect(received).toEqual([JSON.stringify({ value: 42 })]);
        });

        it('stringifies null envelope data', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const received: string[] = [];

            conn.on('evt', msg => received.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage(JSON.stringify({ event: 'evt', data: null }));

            expect(received).toEqual(['null']);
        });

        it('delivers a non-JSON frame only to message subscribers', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const namedReceived: string[] = [];
            const messageReceived: string[] = [];

            conn.on('update', msg => namedReceived.push(msg.data));
            conn.on('message', msg => messageReceived.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage('not json');

            expect(namedReceived).toEqual([]);
            expect(messageReceived).toEqual(['not json']);
        });

        it.each([
            ['no event', { data: 'something' }],
            ['a non-string event', { event: 42, data: 'something' }],
            ['no data', { event: 'update' }],
        ])('ignores an envelope with %s', (_label, envelope) => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const namedReceived: string[] = [];

            conn.on('update', msg => namedReceived.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage(JSON.stringify(envelope));

            expect(namedReceived).toEqual([]);
        });

        it('delivers a message-event envelope once', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const received: string[] = [];

            conn.on('message', msg => received.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage(JSON.stringify({ event: 'message', data: 'hi' }));

            expect(received).toHaveLength(1);
        });

        it('accepts a frame with no subscribers', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.connect();
            sockets.at(0)?.emitOpen();

            expect(() => sockets.at(0)?.emitMessage('hello')).not.toThrow();
        });

        it('delivers a JSON primitive or null frame only to message subscribers', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const namedReceived: string[] = [];
            const messageReceived: string[] = [];

            conn.on('update', msg => namedReceived.push(msg.data));
            conn.on('message', msg => messageReceived.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage('42');
            sockets.at(0)?.emitMessage('null');

            expect(namedReceived).toEqual([]);
            expect(messageReceived).toEqual(['42', 'null']);
        });
    });

    describe('send()', () => {
        it('sends data over the open socket', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.connect();
            sockets.at(0)?.emitOpen();
            conn.send('hello');

            const socket = sockets.at(0);

            expect(socket).toBeDefined();
            expect(socket?.sentMessages).toEqual(['hello']);
        });

        it('throws when idle', () => {
            const { factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            expect(() => conn.send('msg')).toThrow('Cannot send: WebSocket is not open.');
        });

        it('throws while connecting', () => {
            const { factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.connect();

            expect(() => conn.send('msg')).toThrow('Cannot send: WebSocket is not open.');
        });

        it('throws when closed', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.connect();
            sockets.at(0)?.emitOpen();
            conn.disconnect();

            expect(() => conn.send('msg')).toThrow('Cannot send: WebSocket is not open.');
        });
    });

    describe('socket ownership', () => {
        it('closes the new socket when a state subscriber disconnects as it starts connecting', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.onStateChange(state => {
                if (state === 'connecting') {
                    conn.disconnect();
                }
            });
            conn.connect();
            sockets.at(0)?.emitOpen();

            expect(sockets.at(0)?.closeCalls).toBe(1);
            expect(conn.state).toBe('closed');
        });

        it('cancels the reconnect when a state subscriber disconnects as it is scheduled', async () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({
                url: 'ws://test',
                backoff: fixedBackoff(100),
                webSocketFactory: factory,
            });

            conn.connect();
            sockets.at(0)?.emitOpen();
            conn.onStateChange(state => {
                if (state === 'connecting') {
                    conn.disconnect();
                }
            });
            sockets.at(0)?.emitClose();

            expect(vi.getTimerCount()).toBe(0);

            await vi.advanceTimersByTimeAsync(10_000);

            expect(sockets).toHaveLength(1);
            expect(conn.state).toBe('closed');
        });

        it('ignores events from a socket it has released', () => {
            const received: string[] = [];
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.on('message', msg => received.push(msg.data));
            conn.connect();
            conn.disconnect();
            conn.connect();

            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage('stale');
            sockets.at(0)?.emitClose();

            expect(conn.state).toBe('connecting');
            expect(received).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);

            sockets.at(1)?.emitOpen();
            conn.send('ping');

            expect(sockets.at(1)?.sentMessages).toEqual(['ping']);
        });
    });

    describe('open failures', () => {
        it('wraps a throwing socket factory in a RealtimeError on connect()', () => {
            const recording = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: recording.factory });

            recording.failing = true;

            expect(() => conn.connect()).toThrow(
                expect.objectContaining({
                    name: 'RealtimeError',
                    message: 'Cannot connect: the WebSocket could not be opened.',
                    cause: new Error('factory failed'),
                }),
            );
            expect(conn.state).toBe('idle');
        });

        it('leaves the state closed when the url builder throws on a connect() after disconnect()', () => {
            const cause = new Error('no token');
            let fail = false;
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({
                url: () => {
                    if (fail) {
                        throw cause;
                    }

                    return 'ws://test';
                },
                webSocketFactory: factory,
            });

            conn.connect();
            conn.disconnect();
            fail = true;

            expect(() => conn.connect()).toThrow(expect.objectContaining({ name: 'RealtimeError', cause }));
            expect(conn.state).toBe('closed');
            expect(sockets).toHaveLength(1);
        });

        it('reschedules with backoff and reports the error when the factory throws on a reconnect', async () => {
            const errors: unknown[] = [];
            const recording = makeFactory();
            const { sockets } = recording;
            const conn = new WebSocketConnection({
                url: 'ws://test',
                backoff: new ExponentialBackoff({ initialDelay: 100, multiplier: 2, maxDelay: 10_000 }),
                webSocketFactory: recording.factory,
                onError: error => errors.push(error),
            });

            conn.connect();
            sockets.at(0)?.emitClose();
            recording.failing = true;

            await vi.advanceTimersByTimeAsync(100);

            expect(errors).toEqual([new Error('factory failed')]);
            expect(conn.state).toBe('connecting');
            expect(vi.getTimerCount()).toBe(1);

            recording.failing = false;

            // Attempt 1 waits 200 ms: the failed attempt advanced the backoff.
            await vi.advanceTimersByTimeAsync(199);
            expect(sockets).toHaveLength(1);

            await vi.advanceTimersByTimeAsync(1);
            expect(sockets).toHaveLength(2);

            sockets.at(1)?.emitOpen();
            expect(conn.state).toBe('open');
        });

        it('reschedules without an onError sink when the url builder throws on a reconnect', async () => {
            let calls = 0;
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({
                url: () => {
                    if (++calls === 2) {
                        throw new Error('no token');
                    }

                    return 'ws://test';
                },
                backoff: fixedBackoff(100),
                webSocketFactory: factory,
            });

            conn.connect();
            sockets.at(0)?.emitClose();

            await vi.advanceTimersByTimeAsync(100);

            expect(sockets).toHaveLength(1);
            expect(conn.state).toBe('connecting');

            await vi.advanceTimersByTimeAsync(100);

            expect(sockets).toHaveLength(2);
        });
    });

    describe('onError', () => {
        it('receives errors thrown by message and state subscribers', () => {
            const errors: unknown[] = [];
            const messageError = new Error('message subscriber');
            const stateError = new Error('state subscriber');
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({
                url: 'ws://test',
                webSocketFactory: factory,
                onError: error => errors.push(error),
            });

            conn.on('message', () => {
                throw messageError;
            });
            conn.onStateChange(() => {
                throw stateError;
            });
            conn.connect();
            sockets.at(0)?.emitMessage('hello');

            expect(errors).toEqual([stateError, messageError]);
        });

        it('keeps delivering to remaining subscribers when the sink itself throws', () => {
            const received: string[] = [];
            const states: string[] = [];
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({
                url: 'ws://test',
                webSocketFactory: factory,
                onError: () => {
                    throw new Error('sink exploded');
                },
            });

            conn.on('message', () => {
                throw new Error('subscriber exploded');
            });
            conn.on('message', msg => received.push(msg.data));
            conn.onStateChange(() => {
                throw new Error('subscriber exploded');
            });
            conn.onStateChange(state => states.push(state));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage('hello');

            expect(received).toEqual(['hello']);
            expect(states).toEqual(['connecting', 'open']);
        });
    });
});
