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

        await runReconnect({ beforeReconnect: undefined, isClosed: () => false, reopen, reschedule });

        expect(reopen).toHaveBeenCalledOnce();
        expect(reschedule).not.toHaveBeenCalled();
    });

    it('reopens after the hook resolves when still open', async () => {
        const reopen = vi.fn();
        const reschedule = vi.fn();

        await runReconnect({ beforeReconnect: () => Promise.resolve(), isClosed: () => false, reopen, reschedule });

        expect(reopen).toHaveBeenCalledOnce();
        expect(reschedule).not.toHaveBeenCalled();
    });

    it('does not reopen when the connection closed while the hook was pending', async () => {
        const reopen = vi.fn();
        const reschedule = vi.fn();

        await runReconnect({ beforeReconnect: () => Promise.resolve(), isClosed: () => true, reopen, reschedule });

        expect(reopen).not.toHaveBeenCalled();
        expect(reschedule).not.toHaveBeenCalled();
    });

    it('reschedules when the hook rejects and the connection is still open', async () => {
        const reopen = vi.fn();
        const reschedule = vi.fn();

        await runReconnect({
            beforeReconnect: () => Promise.reject(new Error('refresh failed')),
            isClosed: () => false,
            reopen,
            reschedule,
        });

        expect(reschedule).toHaveBeenCalledOnce();
        expect(reopen).not.toHaveBeenCalled();
    });

    it('does not reschedule when the hook rejects after the connection closed', async () => {
        const reopen = vi.fn();
        const reschedule = vi.fn();

        await runReconnect({
            beforeReconnect: () => Promise.reject(new Error('refresh failed')),
            isClosed: () => true,
            reopen,
            reschedule,
        });

        expect(reschedule).not.toHaveBeenCalled();
        expect(reopen).not.toHaveBeenCalled();
    });
});
