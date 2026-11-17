/**
 * Unit tests for the in-process session lock.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { InProcessSessionLock } from './in-process-session-lock';

describe('InProcessSessionLock', () => {
    it('runs each task once the tasks started before it have settled', async () => {
        const lock = new InProcessSessionLock();
        const events: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });

        const first = lock.run(async () => {
            events.push('first:start');
            await gate;
            events.push('first:end');

            return 'first';
        });
        const second = lock.run(() => {
            events.push('second');

            return Promise.resolve('second');
        });

        await Promise.resolve();
        release();

        await expect(Promise.all([first, second])).resolves.toStrictEqual(['first', 'second']);
        expect(events).toStrictEqual(['first:start', 'first:end', 'second']);
    });

    it('runs the next task after a failed one, and propagates the failure', async () => {
        const lock = new InProcessSessionLock();

        const failed = lock.run(() => Promise.reject(new Error('failed')));
        const next = lock.run(() => Promise.resolve('next'));

        await expect(failed).rejects.toThrow('failed');
        await expect(next).resolves.toBe('next');
    });
});
