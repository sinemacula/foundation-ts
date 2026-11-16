/**
 * Tests for the shared realtime reconnect sequencing.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import { runReconnect } from './reconnect';

describe('runReconnect', () => {
    it('reopens immediately when no beforeReconnect hook is set', async () => {
        const reopen = vi.fn();
        const reschedule = vi.fn();

        await runReconnect({ beforeReconnect: undefined, isStale: () => false, reopen, reschedule });

        expect(reopen).toHaveBeenCalledOnce();
        expect(reschedule).not.toHaveBeenCalled();
    });

    it('reopens after the hook resolves when the attempt is still current', async () => {
        const reopen = vi.fn();
        const reschedule = vi.fn();

        await runReconnect({ beforeReconnect: () => Promise.resolve(), isStale: () => false, reopen, reschedule });

        expect(reopen).toHaveBeenCalledOnce();
        expect(reschedule).not.toHaveBeenCalled();
    });

    it('does not reopen when the attempt was superseded while the hook was pending', async () => {
        const reopen = vi.fn();
        const reschedule = vi.fn();

        await runReconnect({ beforeReconnect: () => Promise.resolve(), isStale: () => true, reopen, reschedule });

        expect(reopen).not.toHaveBeenCalled();
        expect(reschedule).not.toHaveBeenCalled();
    });

    it('reschedules when the hook rejects and the attempt is still current', async () => {
        const reopen = vi.fn();
        const reschedule = vi.fn();

        await runReconnect({
            beforeReconnect: () => Promise.reject(new Error('refresh failed')),
            isStale: () => false,
            reopen,
            reschedule,
        });

        expect(reschedule).toHaveBeenCalledOnce();
        expect(reopen).not.toHaveBeenCalled();
    });

    it('does not reschedule when the hook rejects after the attempt was superseded', async () => {
        const reopen = vi.fn();
        const reschedule = vi.fn();

        await runReconnect({
            beforeReconnect: () => Promise.reject(new Error('refresh failed')),
            isStale: () => true,
            reopen,
            reschedule,
        });

        expect(reschedule).not.toHaveBeenCalled();
        expect(reopen).not.toHaveBeenCalled();
    });

    it('reopens synchronously when no hook is set', () => {
        const reopen = vi.fn();

        void runReconnect({ beforeReconnect: undefined, isStale: () => false, reopen, reschedule: vi.fn() });

        expect(reopen).toHaveBeenCalledOnce();
    });

    it('does not reopen without a hook when the attempt is already stale', async () => {
        const reopen = vi.fn();
        const reschedule = vi.fn();

        await runReconnect({ beforeReconnect: undefined, isStale: () => true, reopen, reschedule });

        expect(reopen).not.toHaveBeenCalled();
        expect(reschedule).not.toHaveBeenCalled();
    });

    it('reschedules instead of reopening when the hook resolves false', async () => {
        const reopen = vi.fn();
        const reschedule = vi.fn();
        const beforeReconnect = vi.fn<() => Promise<unknown>>().mockResolvedValue(false);

        await runReconnect({ beforeReconnect, isStale: () => false, reopen, reschedule });

        expect(reschedule).toHaveBeenCalledOnce();
        expect(reopen).not.toHaveBeenCalled();
    });

    it('does not reschedule when the hook resolves false after the attempt was superseded', async () => {
        const reopen = vi.fn();
        const reschedule = vi.fn();
        const beforeReconnect = vi.fn<() => Promise<unknown>>().mockResolvedValue(false);

        await runReconnect({ beforeReconnect, isStale: () => true, reopen, reschedule });

        expect(reschedule).not.toHaveBeenCalled();
        expect(reopen).not.toHaveBeenCalled();
    });

    it('reopens when the hook resolves true', async () => {
        const reopen = vi.fn();
        const reschedule = vi.fn();
        const beforeReconnect = vi.fn<() => Promise<unknown>>().mockResolvedValue(true);

        await runReconnect({ beforeReconnect, isStale: () => false, reopen, reschedule });

        expect(reopen).toHaveBeenCalledOnce();
        expect(reschedule).not.toHaveBeenCalled();
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
