/**
 * WebSocketConnection reconnects driven by the real token refresh coordinator.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenRefreshCoordinator } from '../http/token-refresh-coordinator';
import type { RefreshOutcome } from '../session/session-outcomes';
import { ExponentialBackoff } from './exponential-backoff';
import type { BeforeReconnectHook } from './reconnect';
import { createFakeWebSocketFactory, type FakeWebSocket } from './test-support/fake-web-socket';
import { WebSocketConnection } from './web-socket-connection';

/** A refresh whose outcome the test settles. */
interface PendingRefresh {
    /** The promise the refresher returned. */
    readonly promise: Promise<RefreshOutcome>;

    /** Settle the refresh with an outcome. */
    readonly settle: (outcome: RefreshOutcome) => void;
}

/**
 * The documented beforeReconnect recipe over a classified refresh.
 */
function refreshBeforeReconnect(
    connection: () => WebSocketConnection,
    coordinator: TokenRefreshCoordinator<RefreshOutcome>,
    captureError: (error: unknown) => void,
): BeforeReconnectHook {
    return async signal => {
        const outcome = await coordinator.refresh();

        if (signal.aborted) {
            return false;
        }

        switch (outcome.kind) {
            case 'refreshed':
                return true;
            case 'retryable':
            case 'superseded':
                return false;
            case 'failed':
                captureError(outcome.error);

                if (!signal.aborted) {
                    connection().disconnect();
                }

                return false;
            case 'rejected':
            case 'interactionRequired':
                connection().disconnect();

                return false;
        }
    };
}

/**
 * Build a connection whose reconnects refresh through a real coordinator.
 */
function setup(captureError: (error: unknown) => void = vi.fn()): {
    /** The connection under test. */
    connection: WebSocketConnection;

    /** The coordinator the hook refreshes through. */
    coordinator: TokenRefreshCoordinator<RefreshOutcome>;

    /** The refresher behind the coordinator. */
    refresher: ReturnType<typeof vi.fn<() => Promise<RefreshOutcome>>>;

    /** Every socket created, in order. */
    sockets: FakeWebSocket[];

    /** The refreshes started so far, in order. */
    refreshes: PendingRefresh[];

    /** Replace the token the url builder reads. */
    rotate: (next: string) => void;
} {
    let token = 'token-1';
    const refreshes: PendingRefresh[] = [];
    const refresher = vi.fn(() => {
        let settle!: (outcome: RefreshOutcome) => void;
        const promise = new Promise<RefreshOutcome>(resolve => {
            settle = resolve;
        });

        refreshes.push({ promise, settle });

        return promise;
    });
    const coordinator = new TokenRefreshCoordinator<RefreshOutcome>({ refresh: refresher });
    const { sockets, factory } = createFakeWebSocketFactory();
    const connection: WebSocketConnection = new WebSocketConnection({
        url: () => `ws://test?token=${token}`,
        backoff: new ExponentialBackoff({ initialDelay: 100, multiplier: 1, maxDelay: 100 }),
        webSocketFactory: factory,
        beforeReconnect: refreshBeforeReconnect(() => connection, coordinator, captureError),
    });

    return {
        connection,
        coordinator,
        refresher,
        sockets,
        refreshes,
        rotate: next => {
            token = next;
        },
    };
}

/**
 * Open the first socket, drop it and let the backoff start the hook.
 */
async function dropAndReachHook(connection: WebSocketConnection, sockets: FakeWebSocket[]): Promise<void> {
    connection.connect();
    sockets.at(0)?.emitOpen();
    sockets.at(0)?.emitClose();

    await vi.advanceTimersByTimeAsync(100);
}

/**
 * Settle the latest refresh and flush the hook's continuation.
 */
async function settleLatest(refreshes: PendingRefresh[], outcome: RefreshOutcome): Promise<void> {
    refreshes.at(-1)?.settle(outcome);

    await vi.advanceTimersByTimeAsync(0);
}

describe('WebSocketConnection with a token refresh beforeReconnect', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('joins an in-flight refresh and reconnects with the rotated token', async () => {
        const { connection, coordinator, refresher, sockets, refreshes, rotate } = setup();
        const httpRefresh = coordinator.refresh();

        await dropAndReachHook(connection, sockets);

        expect(refresher).toHaveBeenCalledOnce();
        expect(sockets).toHaveLength(1);

        rotate('token-2');
        await settleLatest(refreshes, { kind: 'refreshed' });

        await expect(httpRefresh).resolves.toEqual({ kind: 'refreshed' });
        expect(refresher).toHaveBeenCalledOnce();
        expect(sockets.map(socket => socket.url)).toEqual(['ws://test?token=token-1', 'ws://test?token=token-2']);
        expect(connection.state).toBe('connecting');
    });

    it.each<RefreshOutcome>([{ kind: 'retryable', error: new Error('offline') }, { kind: 'superseded' }])(
        'opens no socket and leaves one timer for a $kind outcome',
        async outcome => {
            const { connection, sockets, refreshes } = setup();

            await dropAndReachHook(connection, sockets);
            await settleLatest(refreshes, outcome);

            expect(sockets).toHaveLength(1);
            expect(vi.getTimerCount()).toBe(1);
            expect(connection.state).toBe('connecting');
        },
    );

    it.each<RefreshOutcome>([
        { kind: 'rejected', error: new Error('refused') },
        { kind: 'interactionRequired', pending: { credential: 'pending', requires: ['mfa'] } },
    ])('disconnects with no socket or timer left for a $kind outcome', async outcome => {
        const captureError = vi.fn();
        const { connection, sockets, refreshes } = setup(captureError);

        await dropAndReachHook(connection, sockets);
        await settleLatest(refreshes, outcome);

        expect(sockets).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(connection.state).toBe('closed');
        expect(captureError).not.toHaveBeenCalled();
    });

    it('reports a failed outcome to the application sink and disconnects', async () => {
        const failure = new Error('malformed response');
        const captureError = vi.fn();
        const { connection, sockets, refreshes } = setup(captureError);

        await dropAndReachHook(connection, sockets);
        await settleLatest(refreshes, { kind: 'failed', error: failure });

        expect(captureError).toHaveBeenCalledExactlyOnceWith(failure);
        expect(sockets).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(connection.state).toBe('closed');
    });

    it('does not disconnect a connection the failure sink cycled', async () => {
        let connection!: WebSocketConnection;
        const context = setup(() => {
            connection.disconnect();
            connection.connect();
        });
        const { sockets, refreshes } = context;

        connection = context.connection;

        await dropAndReachHook(connection, sockets);
        await settleLatest(refreshes, { kind: 'failed', error: new Error('malformed response') });

        expect(sockets).toHaveLength(2);
        expect(sockets.at(1)?.closeCalls).toBe(0);
        expect(connection.state).toBe('connecting');
    });

    it('leaves a newer lifecycle alone when the connection is cycled after a terminal outcome settles', async () => {
        const captureError = vi.fn();
        const { connection, sockets, refreshes } = setup(captureError);

        await dropAndReachHook(connection, sockets);

        refreshes.at(-1)?.settle({ kind: 'rejected', error: new Error('refused') });
        connection.disconnect();
        connection.connect();
        sockets.at(1)?.emitOpen();

        await vi.advanceTimersByTimeAsync(0);

        expect(sockets).toHaveLength(2);
        expect(sockets.at(1)?.closeCalls).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(connection.state).toBe('open');
        expect(captureError).not.toHaveBeenCalled();
    });
});
