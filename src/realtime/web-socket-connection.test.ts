/**
 * Unit tests for web-socket-connection.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExponentialBackoff } from './exponential-backoff';
import { RealtimeError } from './realtime-error';
import {
    createFakeWebSocketFactory,
    createWebSocketContractHarness,
    type FakeWebSocket,
} from './test-support/fake-web-socket';
import { describeRealtimeContract } from './test-support/realtime-connection-contract';
import { WebSocketConnection } from './web-socket-connection';

/**
 * Backoff that waits `delay` milliseconds before every attempt.
 */
function fixedBackoff(delay: number): ExponentialBackoff {
    return new ExponentialBackoff({ initialDelay: delay, multiplier: 1, maxDelay: delay });
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

describeRealtimeContract(createWebSocketContractHarness());

describe('WebSocketConnection', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    describe('connect()', () => {
        it('passes protocols to the factory', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
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
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const received: string[] = [];

            conn.on('message', msg => received.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage('hello');

            expect(received).toEqual(['hello']);
        });

        it('labels a raw frame with the message event', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const events: string[] = [];

            conn.on('message', msg => events.push(msg.event));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage('data');

            expect(events).toEqual(['message']);
        });

        it('delivers an envelope to message and named-event subscribers', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
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
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const received: string[] = [];

            conn.on('tick', msg => received.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage(JSON.stringify({ event: 'tick', data: { value: 42 } }));

            expect(received).toEqual([JSON.stringify({ value: 42 })]);
        });

        it('stringifies null envelope data', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const received: string[] = [];

            conn.on('evt', msg => received.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage(JSON.stringify({ event: 'evt', data: null }));

            expect(received).toEqual(['null']);
        });

        it('delivers a non-JSON frame only to message subscribers', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
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
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            const namedReceived: string[] = [];

            conn.on('update', msg => namedReceived.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage(JSON.stringify(envelope));

            expect(namedReceived).toEqual([]);
        });

        it('delivers a message-event envelope to message subscribers once, as the original frame', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });
            const frame = JSON.stringify({ event: 'message', data: 'hi' });
            const received: string[] = [];

            conn.on('message', msg => received.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage(frame);

            expect(received).toEqual([frame]);
        });

        it('does not hand the in-flight envelope to a named handler added by a message handler', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });
            const updates: string[] = [];
            let subscribed = false;

            conn.on('message', () => {
                if (!subscribed) {
                    subscribed = true;
                    conn.on('update', msg => updates.push(msg.data));
                }
            });
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage(JSON.stringify({ event: 'update', data: 'first' }));
            sockets.at(0)?.emitMessage(JSON.stringify({ event: 'update', data: 'second' }));

            expect(updates).toEqual(['second']);
        });

        it('stops named delivery when a message handler disconnects', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });
            const update = vi.fn();

            conn.on('message', () => conn.disconnect());
            conn.on('update', update);
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage(JSON.stringify({ event: 'update', data: 'payload' }));

            expect(update).not.toHaveBeenCalled();
            expect(conn.state).toBe('closed');
        });

        it('accepts a frame with no subscribers', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.connect();
            sockets.at(0)?.emitOpen();

            expect(() => sockets.at(0)?.emitMessage('hello')).not.toThrow();
        });

        it('delivers a JSON primitive or null frame only to message subscribers', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
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

    describe('binary frames', () => {
        const dropped = 'Dropped a binary WebSocket frame: only text frames are supported.';

        it.each([
            ['an ArrayBuffer', new ArrayBuffer(4)],
            ['a Blob', new Blob(['binary'])],
            ['a Uint8Array', new Uint8Array([1, 2])],
        ])('drops %s frame, reports it once and keeps delivering text frames', (_label, payload) => {
            const errors: unknown[] = [];
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({
                url: 'ws://test',
                webSocketFactory: factory,
                onError: error => errors.push(error),
            });
            const messages: string[] = [];
            const updates: string[] = [];

            conn.on('message', msg => messages.push(msg.data));
            conn.on('update', msg => updates.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitMessage(payload);

            expect(messages).toEqual([]);
            expect(updates).toEqual([]);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toBeInstanceOf(RealtimeError);
            expect(errors[0]).toHaveProperty('message', dropped);

            const frame = JSON.stringify({ event: 'update', data: 'text' });

            sockets.at(0)?.emitMessage(frame);

            expect(messages).toEqual([frame]);
            expect(updates).toEqual(['text']);
            expect(errors).toHaveLength(1);
        });

        it.each([
            ['without a sink', undefined],
            [
                'with a throwing sink',
                (): void => {
                    throw new Error('sink exploded');
                },
            ],
        ])('drops a binary frame %s without throwing', (_label, onError) => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({
                url: 'ws://test',
                webSocketFactory: factory,
                ...(onError === undefined ? {} : { onError }),
            });
            const messages: string[] = [];

            conn.on('message', msg => messages.push(msg.data));
            conn.connect();
            sockets.at(0)?.emitOpen();

            expect(() => sockets.at(0)?.emitMessage(new ArrayBuffer(1))).not.toThrow();

            sockets.at(0)?.emitMessage('text');

            expect(messages).toEqual(['text']);
        });

        it('ignores a binary frame from a released socket', () => {
            const errors: unknown[] = [];
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({
                url: 'ws://test',
                webSocketFactory: factory,
                onError: error => errors.push(error),
            });

            conn.connect();
            conn.disconnect();
            sockets.at(0)?.emitMessage(new ArrayBuffer(1));

            expect(errors).toEqual([]);
        });
    });

    describe('send()', () => {
        it('sends data over the open socket', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.connect();
            sockets.at(0)?.emitOpen();
            conn.send('hello');

            const socket = sockets.at(0);

            expect(socket).toBeDefined();
            expect(socket?.sentMessages).toEqual(['hello']);
        });

        it('throws when idle', () => {
            const { factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            expect(() => conn.send('msg')).toThrow('Cannot send: WebSocket is not open.');
        });

        it('throws while connecting', () => {
            const { factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.connect();

            expect(() => conn.send('msg')).toThrow('Cannot send: WebSocket is not open.');
        });

        it('throws when closed', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.connect();
            sockets.at(0)?.emitOpen();
            conn.disconnect();

            expect(() => conn.send('msg')).toThrow('Cannot send: WebSocket is not open.');
        });

        it('throws while connecting even once the socket reports OPEN', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.connect();

            const socket = sockets.at(0);

            socket?.reportReadyState('open');

            expect(() => conn.send('msg')).toThrow(new RealtimeError('Cannot send: WebSocket is not open.'));
            expect(socket?.sentMessages).toEqual([]);
        });

        it.each([
            ['closing', (socket: FakeWebSocket): void => socket.close()],
            ['closed before its close event', (socket: FakeWebSocket): void => socket.reportReadyState('closed')],
        ])('throws once the open socket is %s', (_label, settle) => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.connect();

            const socket = sockets[0] as FakeWebSocket;

            socket.emitOpen();
            settle(socket);

            expect(conn.state).toBe('open');
            expect(() => conn.send('msg')).toThrow(new RealtimeError('Cannot send: WebSocket is not open.'));
            expect(socket.sentMessages).toEqual([]);
        });

        it('sends from an open handler on the first socket and on the reconnected one', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({
                url: 'ws://test',
                backoff: fixedBackoff(100),
                webSocketFactory: factory,
            });

            conn.onStateChange(state => {
                if (state === 'open') {
                    conn.send('hello');
                }
            });
            conn.connect();
            sockets.at(0)?.emitOpen();
            sockets.at(0)?.emitClose();
            vi.advanceTimersByTime(100);
            sockets.at(1)?.emitOpen();

            expect(sockets.at(0)?.sentMessages).toEqual(['hello']);
            expect(sockets.at(1)?.sentMessages).toEqual(['hello']);
        });

        it('sends on the live socket, never on one it has released', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.connect();
            conn.disconnect();
            conn.connect();
            sockets.at(0)?.emitOpen();

            expect(() => conn.send('early')).toThrow('Cannot send: WebSocket is not open.');

            sockets.at(1)?.emitOpen();
            conn.send('ping');

            expect(sockets.at(0)?.sentMessages).toEqual([]);
            expect(sockets.at(1)?.sentMessages).toEqual(['ping']);
        });
    });

    describe('default backoff', () => {
        it.each([
            [0, 500],
            [0.5, 750],
        ])('waits an equal-jittered first delay (random %s gives %s ms)', (sample, delay) => {
            vi.spyOn(Math, 'random').mockReturnValue(sample);

            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.connect();
            sockets.at(0)?.emitClose();

            vi.advanceTimersByTime(delay - 1);
            expect(sockets).toHaveLength(1);

            vi.advanceTimersByTime(1);
            expect(sockets).toHaveLength(2);
        });
    });

    describe('socket ownership', () => {
        it('closes the new socket when a state subscriber disconnects as it starts connecting', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
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
            const { sockets, factory } = createFakeWebSocketFactory();
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
    });

    describe('transport errors', () => {
        it('closes a socket that only errors and reconnects once', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({
                url: 'ws://test',
                backoff: fixedBackoff(100),
                webSocketFactory: factory,
            });

            conn.connect();
            sockets.at(0)?.emitError();

            expect(sockets.at(0)?.closeCalls).toBe(1);
            expect(vi.getTimerCount()).toBe(1);
            expect(conn.state).toBe('connecting');

            vi.advanceTimersByTime(100);

            expect(sockets).toHaveLength(2);
        });

        it.each([
            [
                'an error followed by a close',
                (socket: FakeWebSocket): void => {
                    socket.emitError();
                    socket.emitClose();
                },
            ],
            [
                'a repeated error',
                (socket: FakeWebSocket): void => {
                    socket.emitError();
                    socket.emitError();
                },
            ],
        ])('schedules a single reconnect for %s', (_label, fail) => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({
                url: 'ws://test',
                backoff: fixedBackoff(100),
                webSocketFactory: factory,
            });

            conn.connect();
            sockets.at(0)?.emitOpen();
            fail(sockets[0] as FakeWebSocket);

            expect(sockets.at(0)?.closeCalls).toBe(1);
            expect(vi.getTimerCount()).toBe(1);

            vi.advanceTimersByTime(300);

            expect(sockets).toHaveLength(2);
        });

        it('ignores an error from a released socket', () => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            conn.connect();
            conn.disconnect();
            sockets.at(0)?.emitError();

            expect(sockets.at(0)?.closeCalls).toBe(1);
            expect(vi.getTimerCount()).toBe(0);
            expect(conn.state).toBe('closed');
        });

        it.each([
            [4_999, 200],
            [5_000, 100],
        ])('after %s ms of uptime, an error waits %s ms', (uptime, delay) => {
            const { sockets, factory } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({
                url: 'ws://test',
                backoff: new ExponentialBackoff({ initialDelay: 100, multiplier: 2 }),
                webSocketFactory: factory,
            });

            conn.connect();
            sockets.at(0)?.emitError();
            vi.advanceTimersByTime(100);
            sockets.at(1)?.emitOpen();
            vi.advanceTimersByTime(uptime);
            sockets.at(1)?.emitError();

            vi.advanceTimersByTime(delay - 1);
            expect(sockets).toHaveLength(2);

            vi.advanceTimersByTime(1);
            expect(sockets).toHaveLength(3);
        });
    });

    describe('open failures', () => {
        it('wraps a throwing socket factory in a RealtimeError on connect()', () => {
            const cause = new Error('factory failed');
            const { factory, setError } = createFakeWebSocketFactory();
            const conn = new WebSocketConnection({ url: 'ws://test', webSocketFactory: factory });

            setError(cause);

            expect(() => conn.connect()).toThrow(
                expect.objectContaining({
                    name: 'RealtimeError',
                    message: 'Cannot connect: the WebSocket could not be opened.',
                    cause,
                }),
            );
            expect(conn.state).toBe('idle');
        });

        it('leaves the state closed when the url builder throws on a connect() after disconnect()', () => {
            const cause = new Error('no token');
            let fail = false;
            const { sockets, factory } = createFakeWebSocketFactory();
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
    });
});
