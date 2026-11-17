/**
 * Tests for the shared realtime reconnect sequencing.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import { type BeforeReconnectHook, runReconnect } from './reconnect';

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
        ['does nothing when already stale without a hook', undefined, true, 'none'],
        ['does nothing when stale after the hook resolves', vi.fn(() => Promise.resolve()), true, 'none'],
        ['does nothing when stale after the hook resolves false', vi.fn(() => Promise.resolve(false)), true, 'none'],
        [
            'does nothing when stale after the hook rejects',
            vi.fn(() => Promise.reject(new Error('refresh failed'))),
            true,
            'none',
        ],
    ])('%s', async (_name, beforeReconnect, stale, outcome) => {
        const reopen = vi.fn();
        const reschedule = vi.fn();

        await runReconnect({ beforeReconnect, isStale: () => stale, reopen, reschedule });

        expect(reopen).toHaveBeenCalledTimes(outcome === 'reopen' ? 1 : 0);
        expect(reschedule).toHaveBeenCalledTimes(outcome === 'reschedule' ? 1 : 0);
    });

    it('reopens synchronously when no hook is set', () => {
        const reopen = vi.fn();

        void runReconnect({ beforeReconnect: undefined, isStale: () => false, reopen, reschedule: vi.fn() });

        expect(reopen).toHaveBeenCalledOnce();
    });

    it('reschedules and reports the error when reopening throws', async () => {
        const error = new Error('factory failed');
        const reschedule = vi.fn();
        const onError = vi.fn();

        await runReconnect({
            beforeReconnect: undefined,
            isStale: () => false,
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
                isStale: () => false,
                reopen: () => {
                    throw new Error('factory failed');
                },
                reschedule,
            }),
        ).resolves.toBeUndefined();

        expect(reschedule).toHaveBeenCalledOnce();
    });
});
