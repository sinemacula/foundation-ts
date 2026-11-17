/**
 * Benchmarks for hydrating a session.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe } from 'vitest';

import { measure } from './support/measure';

import { KeyValueSessionPersistence } from '../src/session/key-value-session-persistence';
import type { SessionApi } from '../src/session/session-api';
import { createInitialSessionState, hydrateSession } from '../src/session/session-core';
import { MemoryStorage } from '../src/storage/memory-storage';

/**
 * Reject a call the benchmark never makes.
 */
function unused(): Promise<never> {
    return Promise.reject(new Error('The session API is not used while hydrating.'));
}

const api: SessionApi = { login: unused, refresh: unused, logout: unused, currentUser: unused };
const persistence = new KeyValueSessionPersistence(new MemoryStorage());
const context = { persistence, api, device: () => ({ uuid: 'device', os: 'ios' }), createLineage: () => 'lineage' };
const state = createInitialSessionState();

await persistence.saveIf(
    { revision: 0, lineage: null },
    { lineage: 'lineage', tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAtEpochMs: null } },
);
await hydrateSession(state, context);

describe('hydrateSession', () => {
    measure('hydrates against an unchanged snapshot', async () => {
        await hydrateSession(state, context);
    });
});
