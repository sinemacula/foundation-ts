/**
 * A behaviour scenario over the packed package's subpaths, run under plain
 * Node, in each Metro bundle and under React Native's Jest preset. Every check
 * runs in the realm executing it; the JSON-safe report it returns lets the
 * runner compare the runs.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { bootFoundationCore } from '@sinemacula/foundation/app/boot-foundation-core';
import { api, appConfig } from '@sinemacula/foundation/app/services';
import { Environment } from '@sinemacula/foundation/config/environment';
import { ObjectEnvironmentSource } from '@sinemacula/foundation/config/object-environment-source';
import { FetchHttpClient } from '@sinemacula/foundation/http/fetch-http-client';
import { HttpError, HttpValidationError } from '@sinemacula/foundation/http/http-error';
import { ApiQuery } from '@sinemacula/foundation/query/api-query';
import { createDefaultSessionApi } from '@sinemacula/foundation/session/default-session-api';
import { KeyValueSessionPersistence } from '@sinemacula/foundation/session/key-value-session-persistence';
import {
    createInitialSessionState,
    hydrateSession,
    loginWithCredentials,
    refreshSession,
} from '@sinemacula/foundation/session/session-core';
import { SessionError } from '@sinemacula/foundation/session/session-error';
import { MemoryStorage } from '@sinemacula/foundation/storage/memory-storage';

const BASE_URL = 'https://api.example.test';
const SESSION_KEY = 'session';

const EXPECTED_QUERY =
    'filters=%7B%22status%22%3A%22active%22%2C%22total%22%3A%7B%22%24ge%22%3A100%7D%2C%22customer%22%3A%7B%22country' +
    '%22%3A%22GB%22%7D%7D&order=created_at%3Adesc%2Cid&page=2&limit=25&fields%5Border%5D=id%2Ctotal';

const SIGNED_IN_USER = { id: 7, email: 'ada@example.test', name: 'Ada Lovelace', permissions: [] };

const ROUTES = {
    'POST auth/sign-in': [200, { data: { access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1' } }],
    'GET users/self': [200, { data: { id: 7, email: 'ada@example.test', first_name: 'Ada', last_name: 'Lovelace' } }],
    'POST auth/refresh': [200, { data: { access_token: 'access-2', expires_in: 3600, refresh_token: 'refresh-2' } }],
    'GET orders': [
        422,
        {
            error: {
                status: 422,
                code: 10106,
                title: 'Invalid input',
                detail: 'The total must be positive.',
                meta: { total: ['The total must be positive.'] },
            },
        },
    ],
};

/** A scenario check that failed. */
class ScenarioError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ScenarioError';
    }
}

/** Throw unless `actual` serialises to the same JSON as `expected`. */
function assertEqual(label, actual, expected) {
    const [seen, wanted] = [JSON.stringify(actual), JSON.stringify(expected)];

    if (seen !== wanted) {
        throw new ScenarioError(`${label}: expected ${wanted}, got ${seen}.`);
    }
}

/** A fetch stub answering ROUTES with minimal JSON responses. */
function scriptedFetch(url, init) {
    const route = ROUTES[`${init.method} ${url.slice(BASE_URL.length + 1)}`];

    if (route === undefined) {
        return Promise.reject(new ScenarioError(`Unexpected request: ${init.method} ${url}`));
    }

    const [status, body] = route;

    return Promise.resolve({
        ok: status < 400,
        status,
        headers: { get: name => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
        text: () => Promise.resolve(JSON.stringify(body)),
    });
}

/** Boot the core and check the service accessors return what it built. */
async function boot() {
    const core = await bootFoundationCore(
        {
            createEnvironment: () => new Environment(new ObjectEnvironmentSource({})),
            define: () => ({
                api: { baseUrl: BASE_URL, timeout: 0 },
                app: { name: 'Smoke', environment: 'production', version: '1.0.0' },
                featureFlags: { flags: {} },
                locales: { default: 'en-GB', enabled: ['en-GB'], supported: { 'en-GB': { direction: 'ltr' } } },
            }),
            storage: new MemoryStorage(),
            toasts: { error: () => 'toast', information: () => 'toast' },
            confirm: { confirm: () => Promise.resolve(true) },
            collectHttpContributions: () => ({
                requestInterceptors: [],
                onUnauthorized: null,
                responseErrorHandlers: [],
            }),
        },
        { fetchFn: scriptedFetch },
    );

    assertEqual('api() is the booted client', api() === core.http, true);
    assertEqual('appConfig() is the booted settings', appConfig() === core.settings, true);

    return { app: appConfig().app.name };
}

/**
 * Hydrate, sign in and refresh with rotation, then hydrate a fresh state from a
 * corrupt snapshot.
 */
async function session() {
    const storage = new MemoryStorage();
    const persistence = new KeyValueSessionPersistence(storage, { key: SESSION_KEY });
    const http = new FetchHttpClient({ baseUrl: BASE_URL, fetchFn: scriptedFetch });
    const context = {
        persistence,
        api: createDefaultSessionApi(http, { now: () => 0 }),
        device: () => ({ uuid: 'device', os: 'ios' }),
        createLineage: () => 'lineage-1',
    };
    const state = createInitialSessionState();

    await hydrateSession(state, context);
    const login = await loginWithCredentials(state, context, { email: 'ada@example.test', password: 'secret' });

    assertEqual('login outcome', login, { kind: 'authenticated' });
    assertEqual('signed-in state', [state.accessToken, state.refreshToken], ['access-1', 'refresh-1']);
    assertEqual('signed-in user', state.user, SIGNED_IN_USER);

    const refresh = await refreshSession(state, context);
    const { session: persisted } = await persistence.load();

    assertEqual('refresh outcome', refresh, { kind: 'refreshed' });
    assertEqual('refreshed state', [state.accessToken, state.refreshToken], ['access-2', 'refresh-2']);
    assertEqual('persisted session', [persisted.lineage, persisted.tokens.refreshToken], ['lineage-1', 'refresh-2']);

    storage.set(SESSION_KEY, '{');

    const corrupt = await hydrateSession(createInitialSessionState(), context).then(
        () => {
            throw new ScenarioError('A corrupt snapshot hydrated.');
        },
        error => error,
    );

    assertEqual('corrupt snapshot error', corrupt instanceof SessionError, true);
    assertEqual('corrupt snapshot message', corrupt.message, 'The persisted session could not be read.');
    assertEqual('corrupt snapshot cause', corrupt.cause instanceof SyntaxError, true);

    return {
        user: state.user,
        refresh: refresh.kind,
        tokens: [state.accessToken, state.refreshToken],
        corrupt: [corrupt.name, corrupt.message, corrupt.cause.name],
    };
}

/** Reject a 422 validation envelope as the subpath's own error class. */
async function validation() {
    const http = new FetchHttpClient({ baseUrl: BASE_URL, fetchFn: scriptedFetch });
    const error = await http.get('orders').then(
        () => {
            throw new ScenarioError('The validation envelope resolved.');
        },
        rejection => rejection,
    );

    assertEqual(
        'validation error class',
        [error instanceof HttpValidationError, error instanceof HttpError],
        [true, true],
    );
    assertEqual('validation field errors', error.errors, { total: ['The total must be positive.'] });

    return { name: error.name, status: error.status, message: error.message, errors: error.errors };
}

/** Compile a list query and check it against the literal src produces. */
function query() {
    const compiled = ApiQuery.create()
        .where('status', 'active')
        .where('total', '$ge', 100)
        .whereRelation('customer', relation => relation.where('country', 'GB'))
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .fieldsFor('order', ['id', 'total'])
        .page(2)
        .limit(25)
        .toQueryString();

    assertEqual('query string', compiled, EXPECTED_QUERY);

    return compiled;
}

/**
 * Run every step in order and return the report.
 */
export async function runScenario() {
    return { boot: await boot(), session: await session(), validation: await validation(), query: query() };
}
