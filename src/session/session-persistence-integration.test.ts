/**
 * Integration tests for the session core over the real key-value persistence,
 * asserting both contexts and the stored JSON.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../storage/memory-storage';
import { InProcessSessionLock } from './in-process-session-lock';
import { KeyValueSessionPersistence } from './key-value-session-persistence';
import type { SessionCoreContext } from './session-core';
import {
    createInitialSessionState,
    hydrateSession,
    loginWithCredentials,
    logoutSession,
    refreshSession,
    rehydrateSessionUser,
} from './session-core';
import { SessionError } from './session-error';
import type { SessionState } from './session-state';
import type { FakeAuthOperation } from './test-support/fake-auth-server';
import { FakeAuthServer } from './test-support/fake-auth-server';

const CREDENTIALS = { email: 'alice@example.com', password: 'secret' };

/** A context over the shared store. */
interface Party {
    /** The context's state. */
    readonly state: SessionState;

    /** The context its transitions run with. */
    readonly context: SessionCoreContext;
}

/** Two contexts sharing one persistence, its storage and an exchange lock. */
interface Pair {
    /** The first context. */
    readonly a: Party;

    /** The second context. */
    readonly b: Party;

    /** The storage under the shared persistence. */
    readonly storage: MemoryStorage;

    /** The server both contexts talk to. */
    readonly server: FakeAuthServer;

    /** Hold the next request of the given kind, from either context, until released. */
    readonly hold: (operation: FakeAuthOperation) => () => void;
}

/**
 * Build two contexts sharing one persistence over one storage, one exchange
 * lock and one server.
 */
function pair(): Pair {
    const storage = new MemoryStorage();
    const persistence = new KeyValueSessionPersistence(storage, { lock: new InProcessSessionLock() });
    const exchangeLock = new InProcessSessionLock();
    const server = new FakeAuthServer({ now: () => 0 });
    const gates = new Map<FakeAuthOperation, Promise<void>>();
    let lineages = 0;

    /** Open a context. */
    const party = (): Party => {
        const state = createInitialSessionState();
        const api = server.api({
            accessToken: () => state.accessToken,
            before: operation => {
                const gate = gates.get(operation) ?? Promise.resolve();

                gates.delete(operation);

                return gate;
            },
        });

        /** Create the lineage of a new sign-in. */
        const createLineage = (): string => {
            lineages += 1;

            return `lineage-${String(lineages)}`;
        };

        return {
            state,
            context: { api, persistence, device: () => ({ uuid: 'd', os: 'iOS' }), createLineage, exchangeLock },
        };
    };

    return {
        a: party(),
        b: party(),
        storage,
        server,
        hold: operation => {
            let release!: () => void;

            gates.set(
                operation,
                new Promise<void>(resolve => {
                    release = resolve;
                }),
            );

            return () => {
                release();
            };
        },
    };
}

/**
 * Sign the first context in and bring the second in line, user included.
 */
async function signedIn(): Promise<Pair> {
    const built = pair();

    await loginWithCredentials(built.a.state, built.a.context, CREDENTIALS);
    await hydrateSession(built.b.state, built.b.context);
    await rehydrateSessionUser(built.b.state, built.b.context);

    return built;
}

/**
 * Read the stored snapshot as JSON.
 */
function storedOf(storage: MemoryStorage): unknown {
    return JSON.parse(storage.get('auth.session') ?? 'null');
}

/**
 * Build the stored form of a session.
 */
function storedSession(revision: number, lineage: string, state: SessionState): unknown {
    const { accessToken, refreshToken, expiresAtEpochMs } = state;

    return { revision, session: { lineage, tokens: { accessToken, refreshToken, expiresAtEpochMs } } };
}

/**
 * Let every queued callback run.
 */
async function flush(): Promise<void> {
    for (let turn = 0; turn < 3; turn += 1) {
        await new Promise<void>(resolve => {
            setTimeout(resolve, 0);
        });
    }
}

describe('session core over key-value persistence', () => {
    it('rejects a corrupt store at boot, then lets a sign-in replace it for both contexts', async () => {
        const { a, b, storage } = pair();
        storage.set('auth.session', '{"revision":');

        await expect(hydrateSession(a.state, a.context)).rejects.toBeInstanceOf(SessionError);

        await loginWithCredentials(a.state, a.context, CREDENTIALS);
        await hydrateSession(b.state, b.context);

        expect(storedOf(storage)).toStrictEqual(storedSession(1, 'lineage-1', a.state));
        expect(b.state).toStrictEqual({ ...a.state, user: null });
    });

    it('reports a store corrupted mid-session without a request, keeping the tokens, until a sign-out clears it', async () => {
        const { a, storage, server } = await signedIn();
        const held = { ...a.state };
        storage.set('auth.session', 'garbage');

        const result = await refreshSession(a.state, a.context);

        expect(result.kind).toBe('failed');
        expect(result).toHaveProperty('error', expect.any(SessionError));
        expect(a.state).toStrictEqual(held);
        expect(server.requests.map(request => request.operation)).not.toContain('refresh');

        await logoutSession(a.state, a.context);

        expect(storage.get('auth.session')).toBe('{"revision":1,"session":null}');
        expect(server.session('s1')?.revoked).toBe('signed_out');
    });

    it('hydrates the other context signed out after a sign-out', async () => {
        const { a, b, storage } = await signedIn();

        await logoutSession(a.state, a.context);
        await hydrateSession(b.state, b.context);

        expect(b.state).toStrictEqual(createInitialSessionState());
        expect(storage.get('auth.session')).toBe('{"revision":2,"session":null}');
    });

    it('converges concurrent refreshes on one pair at revision 2', async () => {
        const { a, b, storage, server } = await signedIn();

        await Promise.all([refreshSession(a.state, a.context), refreshSession(b.state, b.context)]);

        expect(server.requests.filter(request => request.operation === 'refresh')).toHaveLength(1);
        expect(b.state).toStrictEqual(a.state);
        expect(storedOf(storage)).toStrictEqual(storedSession(2, 'lineage-1', a.state));
    });

    it('lets a refresh started while another context rotates take that rotation without a request', async () => {
        const { a, b, storage, server, hold } = await signedIn();
        const release = hold('refresh');

        const rotating = refreshSession(a.state, a.context);

        await flush();
        const refreshing = refreshSession(b.state, b.context);

        release();

        await expect(Promise.all([rotating, refreshing])).resolves.toStrictEqual([
            { kind: 'refreshed' },
            { kind: 'refreshed' },
        ]);
        expect(server.requests.filter(request => request.operation === 'refresh')).toHaveLength(1);
        expect(storedOf(storage)).toStrictEqual(storedSession(2, 'lineage-1', b.state));
    });

    it('lets a sign-in in flight while another context signs out land after the clear and stay', async () => {
        const { a, b, storage, server, hold } = await signedIn();
        const release = hold('login');

        const login = loginWithCredentials(b.state, b.context, CREDENTIALS);

        await flush();
        const logout = logoutSession(a.state, a.context);

        await flush();

        expect(storage.get('auth.session')).toBe('{"revision":2,"session":null}');

        release();
        await Promise.all([login, logout]);

        expect(storedOf(storage)).toStrictEqual(storedSession(3, 'lineage-2', b.state));
        expect(b.state.user).not.toBeNull();
        expect(server.requests.map(request => request.operation)).not.toContain('logout');
    });

    it('ends a context hydrated mid-rotation on the rotated pair, keeping its user', async () => {
        const { a, b, storage, hold } = await signedIn();
        const user = b.state.user;
        const release = hold('refresh');

        const rotating = refreshSession(a.state, a.context);

        await flush();
        await hydrateSession(b.state, b.context);
        release();
        await rotating;
        await hydrateSession(b.state, b.context);

        expect(b.state).toStrictEqual({ ...a.state, user });
        expect(b.state.user).not.toBeNull();
        expect(storedOf(storage)).toStrictEqual(storedSession(2, 'lineage-1', b.state));
    });
});
