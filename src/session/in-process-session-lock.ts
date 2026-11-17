/**
 * In-process session lock.
 *
 * A {@link SessionLock} that serialises tasks within one JavaScript context. It
 * suffices only where a single context writes the session, as in React Native
 * or a test; browser tabs sharing storage need a lock they all hold, such as
 * one over the Web Locks API.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { SessionLock } from './session-lock';

/**
 * Run tasks one at a time, in the order they were started.
 */
export class InProcessSessionLock implements SessionLock {
    /** Settles once every task started so far has settled. */
    #tail: Promise<unknown> = Promise.resolve();

    /**
     * Run the task once every task started before it has settled, whether it
     * succeeded or failed.
     */
    run<T>(task: () => Promise<T>): Promise<T> {
        const result = this.#tail.then(task);

        this.#tail = result.catch(() => undefined);

        return result;
    }
}
