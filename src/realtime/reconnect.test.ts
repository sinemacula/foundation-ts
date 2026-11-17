/**
 * Tests for the shared realtime reconnect sequencing.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { TokenRefreshCoordinator } from '../http/token-refresh-coordinator';
import type { RefreshOutcome, RefreshResult } from '../session/session-outcomes';
import { type BeforeReconnectHook, runReconnect } from './reconnect';

/**
 * A signal that is already aborted, or a live one.
 */
function signalFor(aborted: boolean): AbortSignal {
    return aborted ? AbortSignal.abort() : new AbortController().signal;
}

describe('runReconnect', () => {
    it.each<[string, BeforeReconnectHook | undefined, boolean, 'reopen' | 'reschedule' | 'none']>([
        ['reopens when no hook is set', undefined, false, 'reopen'],
        ['reopens when the hook resolves', vi.fn(() => Promise.resolve()), false, 'reopen'],
        ['reopens when the hook resolves true', vi.fn(() => Promise.resolve(true)), false, 'reopen'],
        ['reschedules when the hook resolves false', vi.fn(() => Promise.resolve(false)), false, 'reschedule'],
        [
            'reschedules when the hook rejects',
            vi.fn(() => Promise.reject(new Error('refresh failed'))),
            false,
            'reschedule',
        ],
        ['does nothing when already aborted without a hook', undefined, true, 'none'],
        ['does nothing when aborted after the hook resolves', vi.fn(() => Promise.resolve()), true, 'none'],
        ['does nothing when aborted after the hook resolves false', vi.fn(() => Promise.resolve(false)), true, 'none'],
        [
            'does nothing when aborted after the hook rejects',
            vi.fn(() => Promise.reject(new Error('refresh failed'))),
            true,
            'none',
        ],
    ])('%s', async (_name, beforeReconnect, aborted, outcome) => {
        const reopen = vi.fn();
        const reschedule = vi.fn();

        await runReconnect({ beforeReconnect, signal: signalFor(aborted), reopen, reschedule });

        expect(reopen).toHaveBeenCalledTimes(outcome === 'reopen' ? 1 : 0);
        expect(reschedule).toHaveBeenCalledTimes(outcome === 'reschedule' ? 1 : 0);
    });

    it('passes the attempt signal to the hook', async () => {
        const signal = new AbortController().signal;
        const beforeReconnect = vi.fn((_signal: AbortSignal) => Promise.resolve());

        await runReconnect({ beforeReconnect, signal, reopen: vi.fn(), reschedule: vi.fn() });

        expect(beforeReconnect).toHaveBeenCalledExactlyOnceWith(signal);
    });

    it('abandons the attempt when the signal aborts while the hook is pending', async () => {
        const controller = new AbortController();
        const reopen = vi.fn();
        const reschedule = vi.fn();

        await runReconnect({
            beforeReconnect: () => {
                controller.abort();

                return Promise.resolve();
            },
            signal: controller.signal,
            reopen,
            reschedule,
        });

        expect(reopen).not.toHaveBeenCalled();
        expect(reschedule).not.toHaveBeenCalled();
    });

    it('reopens synchronously when no hook is set', () => {
        const reopen = vi.fn();

        void runReconnect({ beforeReconnect: undefined, signal: signalFor(false), reopen, reschedule: vi.fn() });

        expect(reopen).toHaveBeenCalledOnce();
    });

    it('reschedules and reports the error when reopening throws', async () => {
        const error = new Error('factory failed');
        const reschedule = vi.fn();
        const onError = vi.fn();

        await runReconnect({
            beforeReconnect: undefined,
            signal: signalFor(false),
            reopen: () => {
                throw error;
            },
            reschedule,
            onError,
        });

        expect(reschedule).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    });

    it('reschedules without rejecting when reopening throws and no error sink is set', async () => {
        const reschedule = vi.fn();

        await expect(
            runReconnect({
                beforeReconnect: undefined,
                signal: signalFor(false),
                reopen: () => {
                    throw new Error('factory failed');
                },
                reschedule,
            }),
        ).resolves.toBeUndefined();

        expect(reschedule).toHaveBeenCalledOnce();
    });
});

describe('BeforeReconnectHook types', () => {
    it('accepts hooks that resolve void, true, false or undefined, with or without the signal', () => {
        expectTypeOf(async (): Promise<void> => undefined).toExtend<BeforeReconnectHook>();
        expectTypeOf(async (): Promise<boolean> => true).toExtend<BeforeReconnectHook>();
        expectTypeOf(async (): Promise<false> => false).toExtend<BeforeReconnectHook>();
        expectTypeOf(async (): Promise<undefined> => undefined).toExtend<BeforeReconnectHook>();
        expectTypeOf(async (signal: AbortSignal): Promise<boolean> => !signal.aborted).toExtend<BeforeReconnectHook>();
    });

    it('accepts a boolean token refresh coordinator', () => {
        expectTypeOf<TokenRefreshCoordinator<boolean>['refresh']>().toExtend<BeforeReconnectHook>();
    });

    it('rejects hooks whose result is not a boolean decision', () => {
        expectTypeOf<() => Promise<RefreshResult>>().not.toExtend<BeforeReconnectHook>();
        expectTypeOf<() => Promise<RefreshOutcome>>().not.toExtend<BeforeReconnectHook>();
        expectTypeOf(async (): Promise<string> => 'x').not.toExtend<BeforeReconnectHook>();
        expectTypeOf<() => Promise<unknown>>().not.toExtend<BeforeReconnectHook>();
    });

    it('rejects a synchronous hook', () => {
        expectTypeOf<() => boolean>().not.toExtend<BeforeReconnectHook>();
    });

    it('rejects a hook whose parameter is not an AbortSignal', () => {
        expectTypeOf<(attempt: number) => Promise<void>>().not.toExtend<BeforeReconnectHook>();
    });
});
