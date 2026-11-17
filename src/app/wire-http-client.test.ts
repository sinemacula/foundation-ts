/**
 * Unit tests for the HTTP client wiring unit.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FetchHttpClient } from '../http/fetch-http-client';
import type { HttpClient, HttpRequest, RequestInterceptor, UnauthorizedHandler } from '../http/http-client';
import { HttpError, HttpValidationError, NetworkError } from '../http/http-error';
import type { ModuleHttpContributions } from '../http/module-http-contributions';
import type { Toaster } from '../notifications/toaster';
import type { ErrorReporter } from '../reporting/error-reporter';
import { api, installReporting, installToasts, resetFoundationServices } from './services';
import type { FoundationConfig } from './foundation-config';
import type { WireHttpClientOptions, WireHttpClientTools } from './wire-http-client';
import { wireHttpClient } from './wire-http-client';

/** The body of a successful stub response. */
interface OkBody {
    /** Whether the request succeeded. */
    readonly ok: boolean;
}

/**
 * Build a minimal contract-satisfying configuration fixture.
 */
function createConfig(): FoundationConfig {
    return {
        api: { baseUrl: 'https://api.example.com', timeout: 30_000 },
        app: { name: 'Test App', environment: 'production', version: '1.0.0' },
        featureFlags: { flags: {} },
        locales: {
            default: 'en-US',
            enabled: ['en-US'],
            supported: { 'en-US': { direction: 'ltr' } },
        },
    };
}

/**
 * Build empty module HTTP contributions with optional overrides.
 */
function createContributions(overrides: Partial<ModuleHttpContributions> = {}): ModuleHttpContributions {
    return { requestInterceptors: [], onUnauthorized: null, responseErrorHandlers: [], ...overrides };
}

/**
 * Build a resolved request fixture with optional overrides.
 */
function createRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
    return { method: 'GET', url: 'https://api.example.com/items', headers: {}, body: undefined, ...overrides };
}

/** Build an HTTP client stand-in that fails loudly if any method is invoked. */
function createHttpClientStub(): HttpClient {
    /**
     * Reject every call, since the stub must never be used.
     */
    const fail = (): Promise<never> => Promise.reject(new Error('not implemented'));

    return { get: fail, post: fail, put: fail, patch: fail, delete: fail, download: fail };
}

/** One recorded captureError invocation. */
interface CapturedError {
    /** The captured error. */
    readonly error: unknown;

    /** The context the error was captured with. */
    readonly context: Readonly<Record<string, unknown>> | undefined;
}

/** An error reporter recording every captureError invocation. */
interface RecordingReporter extends ErrorReporter {
    /** Every captured error, in capture order. */
    readonly captured: CapturedError[];
}

/** Build an error reporter that records captured errors with their context. */
function createRecordingReporter(): RecordingReporter {
    const captured: RecordingReporter['captured'] = [];

    return {
        captured,
        captureError: (error, context) => {
            captured.push({ error, context });
        },
        captureMessage: () => undefined,
        setUser: () => undefined,
    };
}

/**
 * A fetch fake recording every call and replaying queued responses in order.
 */
interface FetchStub {
    /** The fetch seam to hand to the client. */
    readonly fetchFn: typeof fetch;

    /** The URL of every call, in call order. */
    readonly urls: string[];

    /** The init of every call, in call order. */
    readonly inits: (RequestInit | undefined)[];
}

/**
 * Build a fetch fake replaying one queued response factory per call.
 *
 * @param responses - response factories consumed in call order; exhausted calls
 * fall back to an empty 200
 */
function createFetchStub(...responses: ReadonlyArray<() => Response>): FetchStub {
    const urls: string[] = [];
    const inits: (RequestInit | undefined)[] = [];

    /**
     * Record the call and replay the next queued response.
     */
    const fetchFn: typeof fetch = (input, init) => {
        urls.push(String(input));
        inits.push(init);

        const factory = responses[urls.length - 1];

        return Promise.resolve(factory === undefined ? new Response('{}', { status: 200 }) : factory());
    };

    return { fetchFn, urls, inits };
}

/** Build a 200 JSON response with an { ok: true } body. */
function jsonOk(): Response {
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A fetch seam for tests whose client must never issue a request. */
const failingFetch: typeof fetch = () => Promise.reject(new Error('fetch must not run in this test'));

/** Optional wiring inputs forwarded by {@link captureTools}. */
type CaptureOverrides = Partial<
    Pick<
        WireHttpClientOptions<FoundationConfig>,
        'config' | 'fetchFn' | 'interceptors' | 'contributions' | 'onResponseError' | 'unexpectedErrorToastKey'
    >
>;

/**
 * Wire a client through a capturing factory override and return the tools.
 */
function captureTools(overrides: CaptureOverrides = {}): WireHttpClientTools<FoundationConfig> {
    let captured: WireHttpClientTools<FoundationConfig> | null = null;

    wireHttpClient({
        config: overrides.config ?? createConfig(),
        fetchFn: overrides.fetchFn ?? failingFetch,
        contributions: overrides.contributions ?? createContributions(),
        ...(overrides.interceptors === undefined ? {} : { interceptors: overrides.interceptors }),
        ...(overrides.onResponseError === undefined ? {} : { onResponseError: overrides.onResponseError }),
        ...(overrides.unexpectedErrorToastKey === undefined
            ? {}
            : { unexpectedErrorToastKey: overrides.unexpectedErrorToastKey }),
        client: tools => {
            captured = tools;

            return createHttpClientStub();
        },
    });

    if (captured === null) {
        throw new Error('client factory was not invoked');
    }

    return captured;
}

/** One raised toast. */
interface RecordedToast {
    /** The toast variant. */
    readonly variant: string;

    /** The toast message key. */
    readonly message: string;
}

/** A Toaster that records raised toasts. */
interface RecordingToaster extends Toaster {
    /** Every raised toast, in order. */
    readonly recorded: RecordedToast[];
}

/** Build a Toaster that records raised toasts. */
function createRecordingToaster(): RecordingToaster {
    const recorded: RecordedToast[] = [];

    return {
        recorded,
        error: message => {
            recorded.push({ variant: 'error', message });

            return 'id';
        },
        information: message => {
            recorded.push({ variant: 'information', message });

            return 'id';
        },
    };
}

describe('wireHttpClient', () => {
    afterEach(() => {
        resetFoundationServices();
    });

    describe('default client', () => {
        it('builds a FetchHttpClient and installs it into the http holder', () => {
            const client = wireHttpClient({
                config: createConfig(),
                fetchFn: failingFetch,
                contributions: createContributions(),
            });

            expect(client).toBeInstanceOf(FetchHttpClient);
            expect(api()).toBe(client);
        });

        it('rejects a timeout above the timer maximum and installs no client', () => {
            const config: FoundationConfig = {
                ...createConfig(),
                api: { baseUrl: 'https://api.example.com', timeout: Infinity },
            };

            /**
             * Wire the client over the out-of-range configuration.
             */
            const wire = (): HttpClient =>
                wireHttpClient({ config, fetchFn: failingFetch, contributions: createContributions() });

            expect(wire).toThrow(RangeError);
            expect(wire).toThrow('The request timeout must be at most 2147483647 ms; pass zero or less for none.');
            expect(() => api()).toThrow('http client accessed before initialisation');
        });

        it('sends requests to the base URL through the fetch seam with a timeout signal', async () => {
            const stub = createFetchStub(() => jsonOk());
            const client = wireHttpClient({
                config: createConfig(),
                fetchFn: stub.fetchFn,
                contributions: createContributions(),
            });

            const result = await client.get<OkBody>('ping');

            expect(result).toEqual({ ok: true });
            expect(stub.urls).toEqual(['https://api.example.com/ping']);
            expect(stub.inits[0]?.signal).toBeInstanceOf(AbortSignal);
        });

        it('runs preset interceptors before module interceptors', async () => {
            const log: string[] = [];

            /**
             * Tag the request as seen by the preset.
             */
            const preset: RequestInterceptor = request => {
                log.push('preset');

                return { ...request, headers: { ...request.headers, 'x-chain': 'preset' } };
            };

            /**
             * Append the module tag to the preset tag.
             */
            const moduleInterceptor: RequestInterceptor = request => {
                log.push('module');

                return {
                    ...request,
                    headers: { ...request.headers, 'x-chain': `${request.headers['x-chain'] ?? 'missing'}+module` },
                };
            };
            const stub = createFetchStub(() => jsonOk());
            const client = wireHttpClient({
                config: createConfig(),
                fetchFn: stub.fetchFn,
                interceptors: [preset],
                contributions: createContributions({ requestInterceptors: [moduleInterceptor] }),
            });

            await client.get('items');

            expect(log).toEqual(['preset', 'module']);
            expect(stub.inits[0]?.headers).toMatchObject({ 'x-chain': 'preset+module' });
        });

        it('retries a 401 once through the module unauthorized handler', async () => {
            const stub = createFetchStub(() => new Response('', { status: 401 }), jsonOk);
            let refreshes = 0;
            const client = wireHttpClient({
                config: createConfig(),
                fetchFn: stub.fetchFn,
                contributions: createContributions({
                    onUnauthorized: () => {
                        refreshes += 1;

                        return Promise.resolve(true);
                    },
                }),
            });

            const result = await client.get<OkBody>('secure');

            expect(result).toEqual({ ok: true });
            expect(refreshes).toBe(1);
            expect(stub.urls).toEqual(['https://api.example.com/secure', 'https://api.example.com/secure']);
        });

        it('rejects a 401 without retrying when no module set an unauthorized handler', async () => {
            const stub = createFetchStub(() => new Response('', { status: 401 }));
            const client = wireHttpClient({
                config: createConfig(),
                fetchFn: stub.fetchFn,
                contributions: createContributions(),
            });

            const pending = client.get('secure');

            await expect(pending).rejects.toBeInstanceOf(HttpError);
            await expect(pending).rejects.toHaveProperty('status', 401);
            expect(stub.urls).toHaveLength(1);
        });

        it('raises the application toast for an unexpected failure end to end', async () => {
            const toaster = createRecordingToaster();
            const reporter = createRecordingReporter();

            installToasts(toaster);
            installReporting(reporter);

            const stub = createFetchStub(() => new Response('{}', { status: 500 }));
            const client = wireHttpClient({
                config: createConfig(),
                fetchFn: stub.fetchFn,
                contributions: createContributions(),
                unexpectedErrorToastKey: 'app.errors.unexpected',
            });

            await client.get('boom').catch(() => undefined);

            expect(toaster.recorded.at(0)?.message).toBe('app.errors.unexpected');
            expect(reporter.captured).toHaveLength(1);
            expect(reporter.captured[0]?.context).toEqual({
                source: 'http',
                method: 'GET',
                url: 'https://api.example.com/boom',
            });
        });
    });

    describe('client factory override', () => {
        it('installs and returns the factory-built client', () => {
            const custom = createHttpClientStub();
            const client = wireHttpClient({
                config: createConfig(),
                fetchFn: failingFetch,
                contributions: createContributions(),
                client: () => custom,
            });

            expect(client).toBe(custom);
            expect(api()).toBe(custom);
        });

        it('threads the merged construction inputs to the factory', () => {
            const config = createConfig();
            const presetInterceptor = vi.fn<RequestInterceptor>();
            const moduleInterceptor = vi.fn<RequestInterceptor>();
            const onUnauthorized = vi.fn<UnauthorizedHandler>();
            const tools = captureTools({
                config,
                fetchFn: failingFetch,
                interceptors: [presetInterceptor],
                contributions: createContributions({
                    requestInterceptors: [moduleInterceptor],
                    onUnauthorized,
                }),
            });

            expect(tools.config).toBe(config);
            expect(tools.fetchFn).toBe(failingFetch);
            expect(tools.interceptors).toHaveLength(2);
            expect(tools.interceptors[0]).toBe(presetInterceptor);
            expect(tools.interceptors[1]).toBe(moduleInterceptor);
            expect(tools.onUnauthorized).toBe(onUnauthorized);
            expect(typeof tools.onResponseError).toBe('function');
        });

        it('defaults tools.onUnauthorized to null when no module contributed one', () => {
            const tools = captureTools();

            expect(tools.onUnauthorized).toBeNull();
        });
    });

    describe('response-error handler resolution', () => {
        it('prefers an explicit override over the toast-key default', () => {
            const toaster = createRecordingToaster();

            installToasts(toaster);

            const error = new HttpError(500, 'Server error.');
            const request = createRequest();
            let receivedError: unknown = null;
            let receivedRequest: HttpRequest | null = null;

            const tools = captureTools({
                onResponseError: (thrown, failed) => {
                    receivedError = thrown;
                    receivedRequest = failed;
                },
                unexpectedErrorToastKey: 'app.errors.unexpected',
            });

            tools.onResponseError(error, request);

            expect(receivedError).toBe(error);
            expect(receivedRequest).toBe(request);
            expect(toaster.recorded).toHaveLength(0);
        });

        it('runs module handlers after an explicit override, in registry order', () => {
            const log: string[] = [];

            const tools = captureTools({
                onResponseError: () => {
                    log.push('override');
                },
                contributions: createContributions({
                    responseErrorHandlers: [
                        () => {
                            log.push('module-a');
                        },
                        () => {
                            log.push('module-b');
                        },
                    ],
                }),
            });

            tools.onResponseError(new Error('boom'), createRequest());

            expect(log).toEqual(['override', 'module-a', 'module-b']);
        });

        it('runs module handlers after the default handler with the exact failure', () => {
            const order: string[] = [];
            const reporter: ErrorReporter = {
                captureError: () => {
                    order.push('capture');
                },
                captureMessage: () => undefined,
                setUser: () => undefined,
            };

            installReporting(reporter);

            const error = new Error('boom');
            const request = createRequest();
            const received: [unknown, HttpRequest][] = [];

            const tools = captureTools({
                contributions: createContributions({
                    responseErrorHandlers: [
                        (thrown, failed) => {
                            received.push([thrown, failed]);
                            order.push('module-1');
                        },
                        () => {
                            order.push('module-2');
                        },
                    ],
                }),
            });

            tools.onResponseError(error, request);

            expect(order).toEqual(['capture', 'module-1', 'module-2']);
            expect(received).toEqual([[error, request]]);
        });

        it('notifies module handlers even for failures the default handler skips', () => {
            const reporter = createRecordingReporter();

            installReporting(reporter);

            const log: string[] = [];
            const tools = captureTools({
                contributions: createContributions({
                    responseErrorHandlers: [
                        () => {
                            log.push('module');
                        },
                    ],
                }),
            });

            tools.onResponseError(new HttpError(401, 'Unauthenticated.'), createRequest());

            expect(log).toEqual(['module']);
            expect(reporter.captured).toHaveLength(0);
        });

        it('runs every handler and captures each failure when handlers throw', () => {
            const reporter = createRecordingReporter();

            installReporting(reporter);

            const log: string[] = [];
            const presetFailure = new Error('override exploded');
            const moduleFailure = new Error('module exploded');
            const tools = captureTools({
                onResponseError: () => {
                    log.push('override');

                    throw presetFailure;
                },
                contributions: createContributions({
                    responseErrorHandlers: [
                        () => {
                            log.push('module-a');

                            throw moduleFailure;
                        },
                        () => {
                            log.push('module-b');
                        },
                    ],
                }),
            });

            tools.onResponseError(new Error('boom'), createRequest({ url: 'https://api.example.com/items#top' }));

            expect(log).toEqual(['override', 'module-a', 'module-b']);
            expect(reporter.captured).toEqual([
                {
                    error: presetFailure,
                    context: {
                        source: 'http-response-error-handler',
                        method: 'GET',
                        url: 'https://api.example.com/items',
                    },
                },
                {
                    error: moduleFailure,
                    context: {
                        source: 'http-response-error-handler',
                        method: 'GET',
                        url: 'https://api.example.com/items',
                    },
                },
            ]);
        });

        it('drops a handler failure without throwing when the reporter is unavailable', () => {
            const log: string[] = [];
            const tools = captureTools({
                onResponseError: () => {
                    throw new Error('override exploded');
                },
                contributions: createContributions({
                    responseErrorHandlers: [
                        () => {
                            log.push('module');
                        },
                    ],
                }),
            });

            expect(() => {
                tools.onResponseError(new Error('boom'), createRequest());
            }).not.toThrow();
            expect(log).toEqual(['module']);
        });
    });

    describe('default response-error handler', () => {
        it('toasts and captures an unexpected HttpError with request context', () => {
            const toaster = createRecordingToaster();
            const reporter = createRecordingReporter();

            installToasts(toaster);
            installReporting(reporter);

            const error = new HttpError(500, 'Server error.');
            const request = createRequest({ method: 'POST', url: 'https://api.example.com/items' });
            const tools = captureTools({ unexpectedErrorToastKey: 'app.errors.unexpected' });

            tools.onResponseError(error, request);

            expect(toaster.recorded).toHaveLength(1);
            expect(toaster.recorded.at(0)?.variant).toBe('error');
            expect(toaster.recorded.at(0)?.message).toBe('app.errors.unexpected');
            expect(reporter.captured).toEqual([
                { error, context: { source: 'http', method: 'POST', url: 'https://api.example.com/items' } },
            ]);
        });

        const skippedFailures = [
            {
                name: 'a validation failure',
                error: new HttpValidationError(422, 'Invalid.', null, { name: ['Required.'] }),
            },
            { name: 'a 401 response', error: new HttpError(401, 'Unauthenticated.') },
        ];

        for (const { name, error } of skippedFailures) {
            it(`stays silent for ${name}`, () => {
                const toaster = createRecordingToaster();
                const reporter = createRecordingReporter();

                installToasts(toaster);
                installReporting(reporter);

                const tools = captureTools({ unexpectedErrorToastKey: 'app.errors.unexpected' });

                tools.onResponseError(error, createRequest());

                expect(toaster.recorded).toHaveLength(0);
                expect(reporter.captured).toHaveLength(0);
            });
        }

        const notifiedFailures = [
            { name: 'a non-401 HttpError', error: new HttpError(404, 'Not found.') },
            { name: 'a network failure', error: new NetworkError('GET failed without a response.') },
            { name: 'a plain error', error: new Error('boom') },
        ];

        for (const { name, error } of notifiedFailures) {
            it(`toasts and captures ${name}`, () => {
                const toaster = createRecordingToaster();
                const reporter = createRecordingReporter();

                installToasts(toaster);
                installReporting(reporter);

                const tools = captureTools({ unexpectedErrorToastKey: 'app.errors.unexpected' });

                tools.onResponseError(error, createRequest());

                expect(toaster.recorded).toHaveLength(1);
                expect(toaster.recorded.at(0)?.message).toBe('app.errors.unexpected');
                expect(reporter.captured).toHaveLength(1);
                expect(reporter.captured[0]?.error).toBe(error);
            });
        }

        it('captures without toasting when no toast key is configured', () => {
            const toaster = createRecordingToaster();
            const reporter = createRecordingReporter();

            installToasts(toaster);
            installReporting(reporter);

            const error = new HttpError(500, 'Server error.');
            const request = createRequest();
            const tools = captureTools();

            tools.onResponseError(error, request);

            expect(toaster.recorded).toHaveLength(0);
            expect(reporter.captured).toEqual([
                { error, context: { source: 'http', method: 'GET', url: 'https://api.example.com/items' } },
            ]);
        });

        it('still skips expected failures when no toast key is configured', () => {
            const reporter = createRecordingReporter();

            installReporting(reporter);

            const tools = captureTools();

            tools.onResponseError(
                new HttpValidationError(422, 'Invalid.', null, { name: ['Required.'] }),
                createRequest(),
            );
            tools.onResponseError(new HttpError(401, 'Unauthenticated.'), createRequest());

            expect(reporter.captured).toHaveLength(0);
        });

        it('never resolves the toast service when no toast key is configured', () => {
            const reporter = createRecordingReporter();

            installReporting(reporter);

            // The toast holder stays uninstalled - resolving it would throw.
            const tools = captureTools();

            tools.onResponseError(new Error('boom'), createRequest());

            expect(reporter.captured).toHaveLength(1);
        });

        it('strips the query string and fragment from the reported URL', () => {
            const reporter = createRecordingReporter();

            installReporting(reporter);

            const error = new HttpError(500, 'Server error.');
            const tools = captureTools();

            tools.onResponseError(error, createRequest({ url: 'https://api.example.com/reset?token=secret#done' }));

            expect(reporter.captured).toEqual([
                { error, context: { source: 'http', method: 'GET', url: 'https://api.example.com/reset' } },
            ]);
        });

        it('captures both the failure and a throwing toast', () => {
            const reporter = createRecordingReporter();
            const toastFailure = new Error('toaster exploded');

            installReporting(reporter);
            installToasts({
                error: () => {
                    throw toastFailure;
                },
                information: () => 'id',
            });

            const error = new HttpError(500, 'Server error.');
            const tools = captureTools({ unexpectedErrorToastKey: 'app.errors.unexpected' });

            tools.onResponseError(error, createRequest({ url: 'https://api.example.com/items?page=2' }));

            expect(reporter.captured).toEqual([
                {
                    error: toastFailure,
                    context: {
                        source: 'http-response-error-handler',
                        method: 'GET',
                        url: 'https://api.example.com/items',
                    },
                },
                { error, context: { source: 'http', method: 'GET', url: 'https://api.example.com/items' } },
            ]);
        });

        it('reads the toast and reporting services lazily on each invocation', () => {
            const tools = captureTools({ unexpectedErrorToastKey: 'app.errors.unexpected' });

            expect(() => {
                tools.onResponseError(new HttpError(500, 'Server error.'), createRequest());
            }).not.toThrow();

            const toaster = createRecordingToaster();
            const reporter = createRecordingReporter();

            installToasts(toaster);
            installReporting(reporter);

            tools.onResponseError(new HttpError(500, 'Server error.'), createRequest());

            expect(toaster.recorded).toHaveLength(1);
            expect(reporter.captured).toHaveLength(1);
        });
    });
});
