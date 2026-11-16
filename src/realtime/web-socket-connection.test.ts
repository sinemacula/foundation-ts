/**
 * Unit tests for web-socket-connection.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExponentialBackoff } from './exponential-backoff';
import { RealtimeError } from './realtime-error';
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
     *
     * @param url - the WebSocket endpoint URL
     * @param protocols - optional subprotocol(s)
     */
    constructor(url: string, protocols?: string | readonly string[]) {
        this.url = url;
        this.protocols = protocols;
    }

    /**
     * Record an outbound frame.
     *
     * @param data - the frame text
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
     *
     * @param data - the frame text
     */
    emitMessage(data: string): void {
        this.onmessage?.(new MessageEvent('message', { data }));
    }

    /**
     * Simulate the socket closing.
     */
    emitClose(): void {
        // Not the DOM CloseEvent: that global only exists from node 23, and the
        // connection's close handler never reads the event anyway.
        this.onclose?.(new Event('close') as CloseEvent);
    }
}

/** A recording factory and the fakes it has created so far. */
interface RecordingFactory {
    /** Every fake socket created, in order. */
    readonly sockets: FakeWebSocket[];

    /** The factory to inject into the connection. */
    readonly factory: WebSocketFactory;
}

/**
 * Create a typed {@link WebSocketFactory} that records each fake it creates.
 * The cast to `WebSocket` is confined to the closure so every test body can use
 * the strongly-typed {@link FakeWebSocket} directly.
 *
 * @param failures - how many leading calls throw instead of creating a socket
 * @returns the recorded sockets and the factory
 */
function makeFactory(failures: number = 0): RecordingFactory {
    const sockets: FakeWebSocket[] = [];
    let remainingFailures = failures;

    /**
     * Create and record a fake socket, or throw while failures remain.
     *
     * @param url - the WebSocket endpoint URL
     * @param protocols - optional subprotocol(s)
     * @returns the fake, typed as a WebSocket
     */
    const factory: WebSocketFactory = (url, protocols) => {
        if (remainingFailures > 0) {
            remainingFailures--;

            throw new Error('factory failed');
        }

        const socket = new FakeWebSocket(url, protocols);

        sockets.push(socket);

        return socket as unknown as WebSocket;
    };

    return { sockets, factory };
}

/**
 * Fixed-delay backoff for deterministic reconnect assertions.
 *
 * @param delay - the delay in milliseconds for every attempt
 * @returns the backoff strategy
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
         *
         * @param args - the arguments the constructor received
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

        it('passes just the url to the platform WebSocket when no protocols are set', () => {
            const calls = stubGlobalWebSocket();
            const conn = new WebSocketConnection({ url: 'ws://localhost' });

            conn.connect();

            expect(calls).toEqual([['ws://localhost']]);
        });

        it('passes a string protocol through to the platform WebSocket', () => {
            const calls = stubGlobalWebSocket();
            const conn = new WebSocketConnection({ url: 'ws://localhost', protocols: 'v1' });

            conn.connect();

            expect(calls).toEqual([['ws://localhost', 'v1']]);
        });

        it('passes a protocols array through to the platform WebSocket', () => {
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

        it('sets event to "message" for raw frame delivery', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const events: string[] = [];

            conn.on('message', msg => events.push(msg.event));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage('data');

            expect(events).toEqual(['message']);
        });

        it('keeps delivering to remaining subscribers when one throws', () => {
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

        it('delivers an envelope frame to both message and named-event subscribers', () => {
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

        it('handles a JSON envelope whose data is null', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const received: string[] = [];

            conn.on('evt', msg => received.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage(JSON.stringify({ event: 'evt', data: null }));

            expect(received).toEqual(['null']);
        });

        it('does not dispatch to named-event subscribers for non-JSON frames', () => {
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

        it('does not dispatch to named-event subscribers for invalid envelope shapes', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const namedReceived: string[] = [];

            conn.on('update', msg => namedReceived.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();

            // Missing 'event' field.
            sockets.at(0)?.emitMessage(JSON.stringify({ data: 'something' }));
            // Non-string 'event' field.
            sockets.at(0)?.emitMessage(JSON.stringify({ event: 42, data: 'something' }));
            // Missing 'data' field.
            sockets.at(0)?.emitMessage(JSON.stringify({ event: 'update' }));

            expect(namedReceived).toEqual([]);
        });

        it('delivers envelope "message" event frames only to message subscribers once', () => {
            // An envelope with event='message' should not be double-delivered.
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const received: string[] = [];

            conn.on('message', msg => received.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage(JSON.stringify({ event: 'message', data: 'hi' }));

            // Delivered once via the raw-frame path; not a second time from the
            // envelope path.
            expect(received).toHaveLength(1);
        });

        it('does not deliver messages when no handlers are registered for the event', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.connect();
            sockets.at(0)?.emitOpen();

            // No handler registered - must not throw.
            expect(() => sockets.at(0)?.emitMessage('hello')).not.toThrow();
        });

        it('does not treat a JSON primitive or null frame as an envelope', () => {
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const namedReceived: string[] = [];
            const messageReceived: string[] = [];

            conn.on('update', msg => namedReceived.push(msg.data));
            conn.on('message', msg => messageReceived.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();

            // A frame that is valid JSON but not an object is not an envelope;
            // it is delivered only as the raw message frame.
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

        it('throws when the socket is not open (idle)', () => {
            const { factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            expect(() => conn.send('msg')).toThrow('Cannot send: WebSocket is not open.');
        });

        it('throws when the socket is connecting', () => {
            const { factory } = makeFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.connect();

            expect(() => conn.send('msg')).toThrow('Cannot send: WebSocket is not open.');
        });

        it('throws when the socket is closed', () => {
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
        it('throws a RealtimeError carrying the cause and leaves the state idle when the factory throws on connect()', () => {
            const { sockets, factory } = makeFactory(1);
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });
            const states: string[] = [];

            conn.onStateChange(state => states.push(state));

            let thrown: unknown;

            try {
                conn.connect();
            } catch (error) {
                thrown = error;
            }

            expect(thrown).toBeInstanceOf(RealtimeError);
            expect((thrown as RealtimeError).message).toBe('Cannot connect: the WebSocket could not be opened.');
            expect((thrown as RealtimeError).cause).toEqual(new Error('factory failed'));
            expect(conn.state).toBe('idle');
            expect(states).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);

            conn.connect();

            expect(sockets).toHaveLength(1);
            expect(conn.state).toBe('connecting');
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
            const { sockets, factory } = makeFactory();
            let failing = false;
            const conn = new WebSocketConnection({
                url: 'ws://test',
                backoff: new ExponentialBackoff({ initialDelay: 100, multiplier: 2, maxDelay: 10_000 }),
                webSocketFactory: (url, protocols) => {
                    if (failing) {
                        throw new Error('factory failed');
                    }

                    return factory(url, protocols);
                },
                onError: error => errors.push(error),
            });

            conn.connect();
            sockets.at(0)?.emitClose();
            failing = true;

            await vi.advanceTimersByTimeAsync(100);

            expect(errors).toEqual([new Error('factory failed')]);
            expect(conn.state).toBe('connecting');
            expect(vi.getTimerCount()).toBe(1);

            failing = false;

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

    describe('beforeReconnect resolving false', () => {
        it('abandons the attempt without opening a socket and retries through backoff', async () => {
            const beforeReconnect = vi
                .fn<() => Promise<unknown>>()
                .mockResolvedValueOnce(false)
                .mockResolvedValue(true);
            const { sockets, factory } = makeFactory();
            const conn = new WebSocketConnection({
                url: 'ws://test',
                backoff: fixedBackoff(100),
                beforeReconnect,
                webSocketFactory: factory,
            });

            conn.connect();
            sockets.at(0)?.emitClose();

            await vi.advanceTimersByTimeAsync(100);

            expect(sockets).toHaveLength(1);
            expect(conn.state).toBe('connecting');
            expect(vi.getTimerCount()).toBe(1);

            await vi.advanceTimersByTimeAsync(100);

            expect(beforeReconnect).toHaveBeenCalledTimes(2);
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
