/**
 * Integration tests for browser tabs whose shared storage reaches each tab only
 * after a delay, against an authentication server that revokes a session on any
 * replayed refresh token.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import type { KeyValueStorage } from '../storage/key-value-storage';
import { MemoryStorage } from '../storage/memory-storage';
import { InProcessSessionLock } from './in-process-session-lock';
import { KeyValueSessionPersistence } from './key-value-session-persistence';
import { KeyValueSessionRecordStore } from './key-value-session-record-store';
import { RecordSessionPersistence } from './record-session-persistence';
import type { SessionCoreContext } from './session-core';
import { createInitialSessionState, hydrateSession, loginWithCredentials, refreshSession } from './session-core';
import type { SessionPersistence } from './session-persistence';
import type { SessionState } from './session-state';
import { FakeAuthServer } from './test-support/fake-auth-server';

/**
 * One storage as tabs in separate processes see it: each tab reads its own
 * copy, which another tab's write reaches only once delivered.
 */
class LaggingStorage {
    /** Each tab's copy. */
    readonly #copies: MemoryStorage[] = [];

    /** Writes waiting to reach the other tabs' copies. */
    readonly #pending: Array<() => void> = [];

    /**
     * Open a tab's view, starting from an empty copy.
     */
    view(): KeyValueStorage {
        const copy = new MemoryStorage();

        this.#copies.push(copy);

        return {
            get: key => copy.get(key),
            set: (key, value) => {
                copy.set(key, value);
                this.#broadcast(copy, other => {
                    other.set(key, value);
                });
            },
            remove: key => {
                copy.remove(key);
                this.#broadcast(copy, other => {
                    other.remove(key);
                });
            },
        };
    }

    /**
     * Let every pending write reach the other tabs.
     */
    deliver(): void {
        for (const write of this.#pending.splice(0)) {
            write();
        }
    }

    /**
     * Queue a write for every copy but the writer's.
     */
    #broadcast(writer: MemoryStorage, write: (copy: MemoryStorage) => void): void {
        for (const copy of this.#copies) {
            if (copy !== writer) {
                this.#pending.push(() => {
                    write(copy);
                });
            }
        }
    }
}

/** One tab: its state and the context its transitions run with. */
interface Tab {
    /** The tab's session state. */
    readonly state: SessionState;

    /** The context the transitions run with. */
    readonly context: SessionCoreContext;
}

/** Two tabs sharing one server and one exchange lock. */
interface Tabs {
    /** The server, which allows no grace for a spent refresh token. */
    readonly server: FakeAuthServer;

    /** The tab that refreshes first. */
    readonly a: Tab;

    /** The tab that refreshes second. */
    readonly b: Tab;

    /** Let every pending write to the lagging storage reach the other tab. */
    readonly deliver: () => void;
}

/**
 * Open two tabs, each persisting through what the factory builds over its own
 * view of one lagging storage.
 *
 * @param persistence - builds a tab's persistence over its view
 */
function tabs(persistence: (view: KeyValueStorage) => SessionPersistence): Tabs {
    const server = new FakeAuthServer({ now: () => 1_000_000, graceMs: 0 });
    const storage = new LaggingStorage();
    const exchangeLock = new InProcessSessionLock();

    /**
     * Open one tab.
     */
    const tab = (): Tab => {
        const state = createInitialSessionState();

        return {
            state,
            context: {
                api: server.api({ accessToken: () => state.accessToken }),
                persistence: persistence(storage.view()),
                device: () => ({ uuid: 'device', os: 'macOS' }),
                createLineage: () => 'lineage',
                exchangeLock,
            },
        };
    };

    return { server, a: tab(), b: tab(), deliver: () => storage.deliver() };
}

/**
 * Sign A in and bring B in line with it once the write has reached B, then
 * refresh both at once.
 *
 * @returns the outcomes of A's and B's refreshes
 */
async function refreshTogether({ a, b, deliver }: Tabs): Promise<unknown[]> {
    await loginWithCredentials(a.state, a.context, { email: 'alice@example.com', password: 'secret' });
    deliver();
    await hydrateSession(b.state, b.context);

    return Promise.all([refreshSession(a.state, a.context), refreshSession(b.state, b.context)]);
}

/**
 * Count the refresh requests the server served.
 */
function refreshes(server: FakeAuthServer): number {
    return server.requests.filter(request => request.operation === 'refresh').length;
}

describe('tabs whose storage reaches each other late', () => {
    it('share one rotation, presenting no spent token, when they persist through a transactional store', async () => {
        const shared = new MemoryStorage();
        const lock = new InProcessSessionLock();
        const built = tabs(() => new RecordSessionPersistence(new KeyValueSessionRecordStore(shared, { lock })));

        const outcomes = await refreshTogether(built);

        expect(outcomes).toStrictEqual([{ kind: 'refreshed' }, { kind: 'refreshed' }]);
        expect(refreshes(built.server)).toBe(1);
        expect(built.server.session('s1')?.revoked).toBeNull();
        expect(built.b.state).toStrictEqual({ ...built.a.state, user: null });
    });

    it('present the spent token when each persists through its own lagging view', async () => {
        const lock = new InProcessSessionLock();
        const built = tabs(view => new KeyValueSessionPersistence(view, { lock }));

        const [first, second] = await refreshTogether(built);

        expect(first).toStrictEqual({ kind: 'refreshed' });
        expect(second).toHaveProperty('kind', 'rejected');
        expect(refreshes(built.server)).toBe(2);
        expect(built.server.session('s1')?.revoked).toBe('rotation_reuse');
    });
});
