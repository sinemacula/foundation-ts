/**
 * Tests for the single-flight token refresh coordinator.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { RefreshOutcome } from '../session/session-outcomes';
import { TokenRefreshCoordinator } from './token-refresh-coordinator';

/** A promise plus its externally callable settlers. */
interface Deferred<T> {
    /** The controlled promise. */
    readonly promise: Promise<T>;

    /** Settle the promise successfully. */
    readonly resolve: (value: T) => void;

    /** Settle the promise with a failure. */
    readonly reject: (reason?: unknown) => void;
}

/**
 * Create a promise whose settlement the test controls.
 */
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((resolveValue, rejectValue) => {
        resolve = resolveValue;
        reject = rejectValue;
    });

    return { promise, resolve, reject };
}

/** A refresh outcome richer than a boolean. */
interface Outcome {
    /** The outcome kind. */
    readonly kind: string;
}

describe('TokenRefreshCoordinator', () => {
    it('calls the refresher once for a single refresh', async () => {
        const refreshFn = vi.fn().mockResolvedValue(true);
        const coordinator = new TokenRefreshCoordinator({ refresh: refreshFn });

        await coordinator.refresh();

        expect(refreshFn).toHaveBeenCalledOnce();
    });

    it('returns the refresher result', async () => {
        const coordinator = new TokenRefreshCoordinator({ refresh: vi.fn().mockResolvedValue(true) });

        expect(await coordinator.refresh()).toBe(true);
    });

    it('shares a non-boolean refresher result with every concurrent caller', async () => {
        const { promise, resolve } = deferred<Outcome>();
        const coordinator = new TokenRefreshCoordinator<Outcome>({ refresh: () => promise });
        const outcome = { kind: 'retryable' };

        const first = coordinator.refresh();
        const second = coordinator.refresh();

        resolve(outcome);

        expect(await first).toBe(outcome);
        expect(await second).toBe(outcome);
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

    it('refreshes again once the first refresh settles', async () => {
        const refreshFn = vi.fn().mockResolvedValue(true);
        const coordinator = new TokenRefreshCoordinator({ refresh: refreshFn });

        await coordinator.refresh();
        await coordinator.refresh();

        expect(refreshFn).toHaveBeenCalledTimes(2);
    });

    it('types a refresh by what its refresher resolves with', () => {
        /**
         * Refresh to a classified outcome.
         */
        const refreshOutcome = (): Promise<RefreshOutcome> => Promise.resolve({ kind: 'refreshed' });

        expectTypeOf(new TokenRefreshCoordinator({ refresh: refreshOutcome }).refresh()).toEqualTypeOf<
            Promise<RefreshOutcome>
        >();
        expectTypeOf(new TokenRefreshCoordinator<RefreshOutcome>({ refresh: refreshOutcome }).refresh()).toEqualTypeOf<
            Promise<RefreshOutcome>
        >();
        expectTypeOf<ReturnType<TokenRefreshCoordinator['refresh']>>().toEqualTypeOf<Promise<boolean>>();
        expectTypeOf(
            () =>
                // @ts-expect-error a boolean refresher cannot back an outcome coordinator
                new TokenRefreshCoordinator<RefreshOutcome>({ refresh: () => Promise.resolve(true) }),
        ).toBeFunction();
    });

    it('clears the in-flight slot when the refresher rejects', async () => {
        const refreshFn = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValue(true);

        const coordinator = new TokenRefreshCoordinator({ refresh: refreshFn });

        await expect(coordinator.refresh()).rejects.toThrow('network down');

        const result = await coordinator.refresh();

        expect(result).toBe(true);
        expect(refreshFn).toHaveBeenCalledTimes(2);
    });

    it('rejects every concurrent caller when the refresher rejects', async () => {
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
