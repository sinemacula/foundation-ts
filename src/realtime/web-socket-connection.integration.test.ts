/**
 * WebSocketConnection against the platform WebSocket and a real server.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type WebSocket as ServerSocket, WebSocketServer } from 'ws';

import { ExponentialBackoff } from './exponential-backoff';
import type { RealtimeState } from './realtime-connection';
import { RealtimeError } from './realtime-error';
import { WebSocketConnection, type WebSocketConnectionOptions } from './web-socket-connection';

/** How long any single wait may take before the case fails. */
const WAIT_MS = 2_000;

/**
 * Settle with `promise`, or reject once `WAIT_MS` passes.
 */
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), WAIT_MS);
    });

    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Resolve the next time `connection` reports `state`.
 */
function untilState(connection: WebSocketConnection, state: RealtimeState): Promise<void> {
    return within(
        new Promise<void>(resolve => {
            const unsubscribe = connection.onStateChange(next => {
                if (next === state) {
                    unsubscribe();
                    resolve();
                }
            });
        }),
        `the ${state} state`,
    );
}

/** A local server recording every upgrade attempt and accepted socket. */
class TestServer extends EventEmitter {
    /** The request URL of every upgrade attempt, in order. */
    readonly attempts: string[] = [];

    /** Every socket the server accepted, in order. */
    readonly accepted: ServerSocket[] = [];

    /** Settles as each accepted socket closes. */
    readonly #closures: Promise<void>[] = [];

    /** The underlying server. */
    readonly #server: WebSocketServer;

    /** Upgrades held until their release, while holding is on. */
    readonly #held: (() => void)[] = [];

    /** Whether new upgrades are held. */
    #holding: boolean = false;

    /**
     * Start listening on an ephemeral port.
     */
    constructor() {
        super();

        this.#server = new WebSocketServer({
            port: 0,
            host: '127.0.0.1',
            verifyClient: (info, accept) => {
                this.attempts.push(info.req.url ?? '');
                this.emit('attempt');

                if (this.#holding) {
                    this.#held.push(() => accept(true));
                } else {
                    accept(true);
                }
            },
        });
        this.#server.on('connection', socket => {
            this.#closures.push(new Promise(resolve => socket.once('close', () => resolve())));
            this.accepted.push(socket);
        });
    }

    /**
     * The URL clients connect to, with `query` appended.
     */
    url(query: string = ''): string {
        return `ws://127.0.0.1:${(this.#server.address() as AddressInfo).port}/${query}`;
    }

    /**
     * Resolve once the server is listening.
     */
    async listening(): Promise<void> {
        await within(once(this.#server, 'listening'), 'the server to listen');
    }

    /**
     * Hold every later upgrade until {@link TestServer.release}.
     */
    hold(): void {
        this.#holding = true;
    }

    /**
     * Stop holding and let every held upgrade proceed.
     */
    release(): void {
        this.#holding = false;

        for (const proceed of this.#held.splice(0)) {
            proceed();
        }
    }

    /**
     * Release held upgrades, terminate accepted sockets and stop listening.
     */
    async close(): Promise<void> {
        this.release();

        for (const socket of this.accepted) {
            socket.terminate();
        }

        await within(Promise.all(this.#closures), 'every accepted socket to close');
        await within(new Promise<void>(resolve => this.#server.close(() => resolve())), 'the server to close');
    }
}

describe('WebSocketConnection against a real WebSocket server', () => {
    let server: TestServer;
    let connections: WebSocketConnection[];
    let sockets: WebSocket[];
    let closures: Promise<void>[];

    /**
     * Construct a connection on the platform WebSocket, recording its sockets.
     */
    function connectionFor(options: Omit<WebSocketConnectionOptions, 'webSocketFactory'>): WebSocketConnection {
        const connection = new WebSocketConnection({
            backoff: new ExponentialBackoff({ initialDelay: 10, multiplier: 1, maxDelay: 10 }),
            ...options,
            webSocketFactory: url => {
                const socket = new WebSocket(url);

                // Closing a connecting socket fires its close event in close().
                closures.push(
                    new Promise(resolve => socket.addEventListener('close', () => resolve(), { once: true })),
                );
                sockets.push(socket);

                return socket;
            },
        });

        connections.push(connection);

        return connection;
    }

    beforeEach(async () => {
        server = new TestServer();
        connections = [];
        sockets = [];
        closures = [];
        await server.listening();
    });

    afterEach(async () => {
        for (const connection of connections) {
            connection.disconnect();
        }

        await within(Promise.all(closures), 'every client socket to close');
        await server.close();
    });

    it('delivers an envelope frame to the named and the message subscribers', async () => {
        const connection = connectionFor({ url: server.url() });
        const frame = JSON.stringify({ event: 'update', data: { id: 7 } });
        const opened = untilState(connection, 'open');
        const named = new Promise<string>(resolve => connection.on('update', message => resolve(message.data)));
        const raw = new Promise<string>(resolve => connection.on('message', message => resolve(message.data)));

        connection.connect();
        await opened;
        server.accepted[0]?.send(frame);

        await expect(within(Promise.all([named, raw]), 'both deliveries')).resolves.toEqual(['{"id":7}', frame]);
    });

    it('reconnects with the token rotated while beforeReconnect was pending', async () => {
        let token = 'first';
        let started!: () => void;
        let release!: () => void;
        const hookStarted = new Promise<void>(resolve => {
            started = resolve;
        });
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const connection = connectionFor({
            url: () => server.url(`?token=${token}`),
            beforeReconnect: () => {
                started();

                return gate;
            },
        });
        const opened = untilState(connection, 'open');

        connection.connect();
        await opened;

        server.accepted[0]?.terminate();
        await within(hookStarted, 'beforeReconnect');

        token = 'second';

        const reopened = untilState(connection, 'open');

        release();
        await reopened;

        expect(server.attempts).toEqual(['/?token=first', '/?token=second']);
    });

    it('cancels a socket that is still connecting without further notifications or upgrades', async () => {
        const connection = connectionFor({ url: server.url() });
        const states: RealtimeState[] = [];

        server.hold();

        const attempted = within(once(server, 'attempt'), 'the upgrade attempt');

        connection.connect();
        await attempted;

        connection.onStateChange(state => states.push(state));
        connection.disconnect();

        expect(states).toEqual(['closed']);

        server.release();
        await within(Promise.all(closures), 'the client socket to close');

        expect(states).toEqual(['closed']);
        expect(server.attempts).toHaveLength(1);

        const reopened = untilState(connection, 'open');

        connection.connect();
        await reopened;

        expect(states).toEqual(['closed', 'connecting', 'open']);
        expect(server.attempts).toHaveLength(2);
    });

    it('refuses to send once the client socket starts closing', async () => {
        const connection = connectionFor({ url: server.url() });
        const opened = untilState(connection, 'open');

        connection.connect();
        await opened;
        sockets[0]?.close();

        expect(connection.state).toBe('open');
        expect(() => connection.send('late')).toThrow(new RealtimeError('Cannot send: WebSocket is not open.'));
    });
});
