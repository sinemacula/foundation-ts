/**
 * Unit tests for token-refresh-coordinator.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import { TokenRefreshCoordinator } from './token-refresh-coordinator';

/** Creates a deferred promise so tests can control resolution timing. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((resolveValue, rejectValue) => {
        resolve = resolveValue;
        reject = rejectValue;
    });

    return { promise, resolve, reject };
}

describe('TokenRefreshCoordinator', () => {
    it('calls the refresher once for a single refresh call', async () => {
        const refreshFn = vi.fn().mockResolvedValue(true);
        const coordinator = new TokenRefreshCoordinator({ refresh: refreshFn });

        await coordinator.refresh();

        expect(refreshFn).toHaveBeenCalledOnce();
    });

    it('returns the refresher result', async () => {
        const coordinator = new TokenRefreshCoordinator({ refresh: vi.fn().mockResolvedValue(true) });

        expect(await coordinator.refresh()).toBe(true);
    });

    it('shares one in-flight promise across concurrent calls', async () => {
        const { promise, resolve } = deferred<boolean>();
        const refreshFn = vi.fn(() => promise);
        const coordinator = new TokenRefreshCoordinator({ refresh: refreshFn });

        const first = coordinator.refresh();
        const second = coordinator.refresh();

        resolve(true);

        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(refreshFn).toHaveBeenCalledOnce();
        expect(firstResult).toBe(true);
        expect(secondResult).toBe(true);
    });

    it('triggers a fresh refresher call after the first settles', async () => {
        const refreshFn = vi.fn().mockResolvedValue(true);
        const coordinator = new TokenRefreshCoordinator({ refresh: refreshFn });

        await coordinator.refresh();
        await coordinator.refresh();

        expect(refreshFn).toHaveBeenCalledTimes(2);
    });

    it('clears the in-flight slot when the refresher rejects', async () => {
        const refreshFn = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValue(true);

        const coordinator = new TokenRefreshCoordinator({ refresh: refreshFn });

        await expect(coordinator.refresh()).rejects.toThrow('network down');

        const result = await coordinator.refresh();

        expect(result).toBe(true);
        expect(refreshFn).toHaveBeenCalledTimes(2);
    });

    it('concurrent calls all reject when the refresher rejects', async () => {
        const { promise, reject } = deferred<boolean>();
        const refreshFn = vi.fn(() => promise);
        const coordinator = new TokenRefreshCoordinator({ refresh: refreshFn });

        const first = coordinator.refresh();
        const second = coordinator.refresh();

        reject(new Error('auth server down'));

        await expect(first).rejects.toThrow('auth server down');
        await expect(second).rejects.toThrow('auth server down');

        expect(refreshFn).toHaveBeenCalledOnce();
    });
});
