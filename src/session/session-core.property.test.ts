/**
 * Property test of the session state machine: two contexts over one real
 * persistence and one authentication server, with every request and storage
 * effect run in a generated order.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../storage/memory-storage';
import { InProcessSessionLock } from './in-process-session-lock';
import { KeyValueSessionPersistence } from './key-value-session-persistence';
import type { PasswordCredentials } from './session-api';
import type { SessionCoreContext } from './session-core';
import {
    clearSession,
    createInitialSessionState,
    hydrateSession,
    loginWithCredentials,
    logoutSession,
    refreshSession,
    rehydrateSessionUser,
} from './session-core';
import type { SessionPersistence, SessionSnapshot } from './session-persistence';
import type { SessionState } from './session-state';
import { FakeAuthServer } from './test-support/fake-auth-server';

/** A context of the two. */
type Who = 'a' | 'b';

/** A transition one context can make. */
type Operation = 'hydrate' | 'alice' | 'bob' | 'refused' | 'refresh' | 'logout' | 'clear' | 'rehydrate';

/** A generated step. */
interface Step {
    /** How many effects the scheduler releases before the next step. */
    readonly pause: number;
}

/** A transition of one context. */
interface Transition extends Step {
    /** The context. */
    readonly who: Who;

    /** What it does. */
    readonly operation: Operation;
}

/** Another writer clearing the store, or time passing. */
interface Happening extends Step {
    /** What happens. */
    readonly who: 'foreign' | 'clock';
}

/** A generated step of either kind. */
type Command = Transition | Happening;

/** A sign-out or clear run once everything else has settled. */
interface Ending {
    /** The context. */
    readonly who: Who;

    /** What it does. */
    readonly operation: 'logout' | 'clear';
}

/** One context's state and the context its transitions run with. */
interface Party {
    /** The context's state. */
    readonly state: SessionState;

    /** The context its transitions run with. */
    readonly context: SessionCoreContext;
}

const CREDENTIALS: Readonly<Record<'alice' | 'bob' | 'refused', PasswordCredentials>> = {
    alice: { email: 'alice@example.com', password: 'secret' },
    bob: { email: 'bob@example.com', password: 'secret' },
    refused: { email: 'alice@example.com', password: 'wrong' },
};

/**
 * A storage recording the revision of every snapshot written.
 */
class RecordingStorage extends MemoryStorage {
    /** The revisions written, in order. */
    readonly revisions: number[] = [];

    /**
     * Record the revision, then store the value.
     */
    override set(key: string, value: string): void {
        this.revisions.push((JSON.parse(value) as SessionSnapshot).revision);
        super.set(key, value);
    }
}

/**
 * Two contexts, another writer and a clock over one store and one server, every
 * effect released by the scheduler.
 */
class World {
    /** The shared storage. */
    readonly storage = new RecordingStorage();

    /** The server. */
    readonly server: FakeAuthServer;

    /** The two contexts. */
    readonly parties: Readonly<Record<Who, Party>>;

    /** The persistence every context shares. */
    readonly #persistence = new KeyValueSessionPersistence(this.storage, { lock: new InProcessSessionLock() });

    /** The scheduler releasing every effect. */
    readonly #scheduler: fc.Scheduler;

    /** Whether each transition started has settled. */
    readonly #settled: boolean[] = [];

    /** The clock. */
    #now = 0;

    constructor(scheduler: fc.Scheduler, graceMs: number, transport: 'body' | 'cookie') {
        const exchangeLock = new InProcessSessionLock();
        let lineages = 0;

        /** Create the lineage of a new sign-in. */
        const createLineage = (): string => {
            lineages += 1;

            return `lineage-${String(lineages)}`;
        };

        this.#scheduler = scheduler;
        this.server = new FakeAuthServer({
            now: () => this.#now,
            graceMs,
            transport,
            accessTtlMs: Number.MAX_SAFE_INTEGER,
        });
        this.parties = {
            a: this.#party('a', exchangeLock, createLineage),
            b: this.#party('b', exchangeLock, createLineage),
        };
    }

    /**
     * Start a generated step, then let the scheduler release as many effects as
     * it pauses for.
     */
    async play(step: Command): Promise<void> {
        if ('operation' in step) {
            this.run(step.who, step.operation);
        } else if (step.who === 'clock') {
            this.#start(
                this.#turn('clock').then(() => {
                    this.#now += 31_000;
                }),
            );
        } else {
            const foreign = this.#scheduled('foreign');

            this.#start(
                foreign
                    .load()
                    .then(({ revision, session }) => foreign.clearIf({ revision, lineage: session?.lineage ?? null })),
            );
        }

        for (let turn = 0; turn < step.pause; turn += 1) {
            await settle();

            if (this.#scheduler.count() > 0) {
                await this.#scheduler.waitNext(1);
            }
        }
    }

    /**
     * Start a transition of one context.
     */
    run(who: Who, operation: Operation): void {
        const { state, context } = this.parties[who];

        switch (operation) {
            case 'hydrate':
                this.#start(hydrateSession(state, context));
                break;
            case 'refresh':
                this.#start(refreshSession(state, context));
                break;
            case 'logout':
                this.#start(logoutSession(state, context));
                break;
            case 'clear':
                this.#start(clearSession(state, context));
                break;
            case 'rehydrate':
                this.#start(rehydrateSessionUser(state, context));
                break;
            default:
                this.#start(loginWithCredentials(state, context, CREDENTIALS[operation]));
        }
    }

    /**
     * Release every effect, failing when a transition can no longer advance.
     */
    async drain(): Promise<void> {
        await this.#scheduler.waitIdle();

        if (this.#settled.includes(false)) {
            throw new Error(`A transition never settled:\n${String(this.#scheduler)}`);
        }
    }

    /**
     * Assert every loaded user belongs to the session that issued its state's
     * access token.
     */
    expectUsersOwnTheirSessions(): void {
        for (const { state } of Object.values(this.parties)) {
            expect(state.user === null || this.server.issuerOf(state.accessToken)?.owner === state.user.id).toBe(true);
        }
    }

    /**
     * Read the stored snapshot.
     */
    stored(): Promise<SessionSnapshot> {
        return this.#persistence.load();
    }

    /**
     * Open a context over the shared store, server and exchange lock.
     */
    #party(who: Who, exchangeLock: InProcessSessionLock, createLineage: () => string): Party {
        const state = createInitialSessionState();
        const api = this.server.api({
            accessToken: () => state.accessToken,
            before: operation => this.#turn(`${who} ${operation}`),
        });

        return {
            state,
            context: {
                api,
                persistence: this.#scheduled(who),
                device: () => ({ uuid: who, os: 'iOS' }),
                createLineage,
                exchangeLock,
            },
        };
    }

    /**
     * Wrap the shared persistence so each effect waits for the scheduler.
     */
    #scheduled(who: string): SessionPersistence {
        const persistence = this.#persistence;

        return {
            load: () => this.#turn(`${who} load`).then(() => persistence.load()),
            saveIf: (expected, session) => this.#turn(`${who} save`).then(() => persistence.saveIf(expected, session)),
            clearIf: expected => this.#turn(`${who} clear`).then(() => persistence.clearIf(expected)),
        };
    }

    /**
     * Wait for the scheduler to release the named effect.
     */
    #turn(label: string): Promise<void> {
        return this.#scheduler.schedule(Promise.resolve(), label);
    }

    /**
     * Track a transition until it settles.
     */
    #start(work: Promise<unknown>): void {
        const index = this.#settled.push(false) - 1;

        /** Record the settlement. */
        const done = (): void => {
            this.#settled[index] = true;
        };

        work.then(done, done);
    }
}

/**
 * Repeat an operation, weighting how often it is drawn.
 */
function repeat(operation: Operation, times: number): Operation[] {
    return Array.from({ length: times }, () => operation);
}

/**
 * Let pending callbacks run, so the effects they schedule reach the scheduler.
 */
async function settle(): Promise<void> {
    for (let tick = 0; tick < 20; tick += 1) {
        await Promise.resolve();
    }
}

const who = fc.constantFrom<Who>('a', 'b');

const command: fc.Arbitrary<Command> = fc.oneof(
    {
        weight: 9,
        arbitrary: fc.record({
            who,
            operation: fc.constantFrom<Operation>(
                ...repeat('hydrate', 3),
                ...repeat('alice', 3),
                ...repeat('bob', 3),
                ...repeat('refused', 2),
                ...repeat('refresh', 5),
                ...repeat('rehydrate', 2),
                'logout',
                'clear',
            ),
            pause: fc.nat(6),
        }),
    },
    { weight: 1, arbitrary: fc.record({ who: fc.constant('foreign' as const), pause: fc.nat(6) }) },
    { weight: 2, arbitrary: fc.record({ who: fc.constant('clock' as const), pause: fc.nat(6) }) },
);

const final: fc.Arbitrary<Ending | null> = fc.option(
    fc.record({ who, operation: fc.constantFrom('logout' as const, 'clear' as const) }),
);

describe('session state machine', () => {
    it('keeps its invariants under every generated interleaving', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.scheduler(),
                fc.array(command, { minLength: 2, maxLength: 16 }),
                final,
                fc.constantFrom(0, 30_000),
                fc.constantFrom('body' as const, 'cookie' as const),
                async (scheduler, commands, last, graceMs, transport) => {
                    const world = new World(scheduler, graceMs, transport);

                    for (const step of commands) {
                        await world.play(step);
                    }

                    await world.drain();
                    world.expectUsersOwnTheirSessions();

                    if (last !== null) {
                        world.run(last.who, last.operation);
                        await world.drain();
                    }

                    world.run('a', 'hydrate');
                    world.run('b', 'hydrate');
                    await world.drain();

                    const stored = await world.stored();

                    expect(world.storage.revisions).toStrictEqual([...world.storage.revisions].sort((x, y) => x - y));
                    expect(
                        world.server.sessions().filter(session => session.revoked === 'rotation_reuse'),
                    ).toStrictEqual([]);

                    if (last !== null) {
                        expect(stored.session).toBeNull();
                    }

                    for (const { state } of Object.values(world.parties)) {
                        expect(state.accessToken).toBe(stored.session?.tokens.accessToken ?? null);
                        expect(state.refreshToken).toBe(stored.session?.tokens.refreshToken ?? null);
                    }

                    world.expectUsersOwnTheirSessions();
                },
            ),
            { seed: 20_261_117, numRuns: 5000 },
        );
    }, 60_000);
});
