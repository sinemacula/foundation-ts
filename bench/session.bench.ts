/**
 * Benchmarks for hydrating a session.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { bench, describe } from 'vitest';

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
const context = { persistence, api, device: () => ({ uuid: 'device', os: 'ios' }) };
const state = createInitialSessionState();

await persistence.saveIf(0, { accessToken: 'access', refreshToken: 'refresh', expiresAtEpochMs: null });
await hydrateSession(state, context);

describe('hydrateSession', () => {
    bench('hydrates against an unchanged snapshot', async () => {
        await hydrateSession(state, context);
    });
});
