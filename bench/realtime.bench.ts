/**
 * Benchmarks for dispatching realtime frames to subscribers.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterAll, describe } from 'vitest';

import { measure } from './support/measure';

import { WebSocketConnection } from '../src/realtime/web-socket-connection';

/** The socket surface the connection drives, with no network behind it. */
interface FakeSocket {
    /** The open handler the connection installs. */
    onopen: (() => void) | null;

    /** The message handler the connection installs. */
    onmessage: ((event: MessageEvent) => void) | null;

    /** The close handler the connection installs. */
    onclose: (() => void) | null;

    /**
     * Accept an outbound frame.
     */
    send(): void;

    /**
     * Accept a close.
     */
    close(): void;
}

/**
 * Open a connection over a fake socket with `handlers` distinct subscribers to
 * `tick`, disconnected after the suite, and return the socket.
 */
function openSocket(handlers: number): FakeSocket {
    const socket: FakeSocket = {
        onopen: null,
        onmessage: null,
        onclose: null,
        send: () => undefined,
        close: () => undefined,
    };
    const connection = new WebSocketConnection({
        url: 'wss://realtime.example.test',
        webSocketFactory: () => socket as unknown as WebSocket,
    });

    for (let index = 0; index < handlers; index++) {
        connection.on('tick', () => undefined);
    }

    connection.connect();
    socket.onopen?.();
    afterAll(() => {
        connection.disconnect();
    });

    return socket;
}

describe('WebSocketConnection dispatch', () => {
    for (const [label, size] of [
        ['1 KB', 1024],
        ['100 KB', 100 * 1024],
    ] as const) {
        const frame = new MessageEvent('message', { data: JSON.stringify({ event: 'tick', data: 'x'.repeat(size) }) });

        for (const handlers of [1, 10]) {
            const socket = openSocket(handlers);

            measure(`dispatches a ${label} frame to ${String(handlers)} handlers`, () => {
                socket.onmessage?.(frame);
            });
        }
    }
});
