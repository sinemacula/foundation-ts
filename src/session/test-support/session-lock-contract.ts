/**
 * SessionLock contract, run against every adapter of the port.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import type { SessionLock } from '../session-lock';

/** The adapter-specific hooks the contract is parameterised by. */
export interface SessionLockContractHarness {
    /**
     * Start a fresh lock.
     *
     * @returns a factory of handles on that one lock, as separate contexts
     * sharing it would hold
     */
    create(): () => SessionLock;
}

/**
 * Let pending callbacks run, giving a lock the chance to start a queued task.
 */
async function settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) {
        await new Promise<void>(resolve => {
            setTimeout(resolve, 0);
        });
    }
}

/**
 * Assert the shared SessionLock contract against one adapter.
 *
 * @param harness - the adapter-specific lock harness
 */
export function describeSessionLockContract(harness: SessionLockContractHarness): void {
    describe('SessionLock contract', () => {
        it('runs tasks from every handle one at a time, in the order they were started', async () => {
            const handles = harness.create();
            const events: string[] = [];
            let release!: () => void;
            const held = new Promise<void>(resolve => {
                release = resolve;
            });

            const first = handles().run(async () => {
                events.push('start first');
                await held;
                events.push('end first');
            });
            const second = handles().run(() => {
                events.push('second');

                return Promise.resolve();
            });
            const third = handles().run(() => {
                events.push('third');

                return Promise.resolve();
            });

            await vi.waitFor(() => {
                expect(events).toStrictEqual(['start first']);
            });
            await settle();

            expect(events).toStrictEqual(['start first']);

            release();
            await Promise.all([first, second, third]);

            expect(events).toStrictEqual(['start first', 'end first', 'second', 'third']);
        });

        it('hands back the value the task resolved with, by identity', async () => {
            const value = { id: 'value' };

            await expect(
                harness
                    .create()()
                    .run(() => Promise.resolve(value)),
            ).resolves.toBe(value);
        });

        it.each([
            ['rejects', (failure: Error) => (): Promise<never> => Promise.reject(failure)],
            [
                'throws synchronously',
                (failure: Error) => (): Promise<never> => {
                    throw failure;
                },
            ],
        ])('propagates the failure of a task that %s, then runs the next', async (_label, task) => {
            const handles = harness.create();
            const failure = new Error('task failed');

            const failed = handles().run(task(failure));
            const next = handles().run(() => Promise.resolve('next'));

            await expect(failed).rejects.toBe(failure);
            await expect(next).resolves.toBe('next');
        });
    });
}
