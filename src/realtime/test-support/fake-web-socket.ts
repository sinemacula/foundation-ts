/**
 * In-memory WebSocket double and the contract harness built on it.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { WebSocketConnection, type WebSocketFactory } from '../web-socket-connection';
import type { RealtimeContractHarness } from './realtime-connection-contract';

/** `WebSocket.CONNECTING`. */
const CONNECTING = 0;

/** `WebSocket.OPEN`. */
const OPEN = 1;

/** `WebSocket.CLOSING`. */
const CLOSING = 2;

/** `WebSocket.CLOSED`. */
const CLOSED = 3;

/** A WebSocket double whose events are fired by the test. */
export class FakeWebSocket {
    /** The URL the socket was opened with. */
    readonly url: string;

    /** The subprotocol(s) the socket was opened with. */
    readonly protocols: string | readonly string[] | undefined;

    /** Every frame passed to send(), in order. */
    readonly sentMessages: string[] = [];

    /** The current ready state, following the platform's transitions. */
    #readyState: number = CONNECTING;

    /** How many times close() was called. */
    #closeCalls: number = 0;

    /** The open handler the connection installs. */
    #onopen: ((event: Event) => void) | null = null;

    /** The message handler the connection installs. */
    #onmessage: ((event: MessageEvent) => void) | null = null;

    /** The close handler the connection installs. */
    #onclose: ((event: CloseEvent) => void) | null = null;

    /** The error handler the connection installs. */
    #onerror: ((event: Event) => void) | null = null;

    /**
     * Record the construction arguments.
     */
    constructor(url: string, protocols?: string | readonly string[]) {
        this.url = url;
        this.protocols = protocols;
    }

    /**
     * The current ready state.
     */
    get readyState(): number {
        return this.#readyState;
    }

    /**
     * How many times close() was called.
     */
    get closeCalls(): number {
        return this.#closeCalls;
    }

    /**
     * The installed open handler.
     */
    get onopen(): ((event: Event) => void) | null {
        return this.#onopen;
    }

    /**
     * Install the open handler.
     */
    set onopen(handler: ((event: Event) => void) | null) {
        this.#onopen = handler;
    }

    /**
     * The installed message handler.
     */
    get onmessage(): ((event: MessageEvent) => void) | null {
        return this.#onmessage;
    }

    /**
     * Install the message handler.
     */
    set onmessage(handler: ((event: MessageEvent) => void) | null) {
        this.#onmessage = handler;
    }

    /**
     * The installed close handler.
     */
    get onclose(): ((event: CloseEvent) => void) | null {
        return this.#onclose;
    }

    /**
     * Install the close handler.
     */
    set onclose(handler: ((event: CloseEvent) => void) | null) {
        this.#onclose = handler;
    }

    /**
     * The installed error handler.
     */
    get onerror(): ((event: Event) => void) | null {
        return this.#onerror;
    }

    /**
     * Install the error handler.
     */
    set onerror(handler: ((event: Event) => void) | null) {
        this.#onerror = handler;
    }

    /**
     * Record an outbound frame.
     */
    send(data: string): void {
        this.sentMessages.push(data);
    }

    /**
     * Record a close call and start closing, as the platform does.
     */
    close(): void {
        this.#closeCalls++;

        if (this.#readyState !== CLOSED) {
            this.#readyState = CLOSING;
        }
    }

    /**
     * Simulate the socket opening.
     */
    emitOpen(): void {
        this.#readyState = OPEN;
        this.#onopen?.(new Event('open'));
    }

    /**
     * Simulate an incoming frame; non-string data models a binary frame.
     */
    emitMessage(data: unknown): void {
        this.#onmessage?.(new MessageEvent('message', { data }));
    }

    /**
     * Simulate the socket closing.
     */
    emitClose(): void {
        this.#readyState = CLOSED;
        // CloseEvent is only a global from node 23, and the handler ignores it.
        this.#onclose?.(new Event('close') as CloseEvent);
    }

    /**
     * Simulate an error event, which some platforms raise without a close.
     */
    emitError(): void {
        this.#onerror?.(new Event('error'));
    }

    /**
     * Report a ready state before the event that announces it is dispatched.
     */
    reportReadyState(state: 'open' | 'closed'): void {
        this.#readyState = state === 'open' ? OPEN : CLOSED;
    }
}

/** A recording factory and the fakes it has created so far. */
export interface FakeWebSocketFactory {
    /** Every fake socket created, in order. */
    readonly sockets: FakeWebSocket[];

    /** The factory to inject into the connection. */
    readonly factory: WebSocketFactory;

    /** While set, the factory throws this error instead of creating a socket. */
    readonly setError: (error: Error | null) => void;
}

/**
 * Create a {@link WebSocketFactory} that records each fake socket it creates.
 */
export function createFakeWebSocketFactory(): FakeWebSocketFactory {
    const sockets: FakeWebSocket[] = [];
    let failure: Error | null = null;

    return {
        sockets,
        factory: (url, protocols) => {
            if (failure !== null) {
                throw failure;
            }

            const socket = new FakeWebSocket(url, protocols);

            sockets.push(socket);

            return socket as unknown as WebSocket;
        },
        setError: error => {
            failure = error;
        },
    };
}

/**
 * The realtime contract harness for {@link WebSocketConnection} on the fake.
 */
export function createWebSocketContractHarness(): RealtimeContractHarness {
    return {
        create(options) {
            const { sockets, factory, setError } = createFakeWebSocketFactory();
            const connection = new WebSocketConnection({ ...options, webSocketFactory: factory });

            return {
                connection,
                setFactoryError: setError,
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
