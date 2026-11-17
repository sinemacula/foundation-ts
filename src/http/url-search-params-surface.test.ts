/**
 * Tests that query encoding and abort classification hold on runtimes shipping
 * only the minimal URLSearchParams and AbortController surfaces.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiQuery } from '../query/api-query';
import { FetchHttpClient } from './fetch-http-client';
import type { QueryParameters } from './http-client';
import { CancelledError, TimeoutError } from './http-error';

/** The fetch call signature, so mock.calls carries a typed tuple. */
type FetchArgs = [input: Request | string | URL, init?: RequestInit];

/**
 * Form-urlencode a value the way WHATWG URLSearchParams does, failing on lone
 * surrogates as a strict encoder would.
 */
function formEncode(value: string): string {
    return encodeURIComponent(value)
        .replace(/[!'()~]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
        .replaceAll('%20', '+');
}

/**
 * Throw for any member the minimal surface does not provide.
 */
function unsupported(member: string): never {
    throw new TypeError(`URLSearchParams.${member} is not supported.`);
}

/**
 * A URLSearchParams with only a no-argument constructor, append and toString.
 */
class MinimalSearchParams {
    /** The appended pairs, in order. */
    readonly #pairs: [string, string][] = [];

    /**
     * Refuse any initialiser, which the minimal surface does not accept.
     */
    constructor(...init: unknown[]) {
        if (init.length > 0) {
            unsupported('constructor(init)');
        }
    }

    /**
     * Append one pair.
     */
    append(name: string, value: string): void {
        this.#pairs.push([name, value]);
    }

    /**
     * Unsupported on the minimal surface.
     */
    set(): never {
        return unsupported('set');
    }

    /**
     * Unsupported on the minimal surface.
     */
    get(): never {
        return unsupported('get');
    }

    /**
     * Unsupported on the minimal surface.
     */
    has(): never {
        return unsupported('has');
    }

    /**
     * Unsupported on the minimal surface.
     */
    delete(): never {
        return unsupported('delete');
    }

    /**
     * Encode the pairs in append order.
     */
    toString(): string {
        return this.#pairs.map(([name, value]) => `${formEncode(name)}=${formEncode(value)}`).join('&');
    }
}

/** An abort signal whose reason stays undefined, as on runtimes without abort reasons. */
interface ReasonlessSignal extends EventTarget {
    /** Whether the signal has aborted. */
    aborted: boolean;

    /** Always undefined. */
    readonly reason: undefined;
}

/**
 * An AbortController whose signal never carries a reason.
 */
class ReasonlessAbortController {
    /** The controlled signal. */
    readonly signal: ReasonlessSignal = Object.assign(new EventTarget(), { aborted: false, reason: undefined });

    /**
     * Abort the signal once, without a reason.
     */
    abort(): void {
        if (!this.signal.aborted) {
            this.signal.aborted = true;
            this.signal.dispatchEvent(new Event('abort'));
        }
    }
}

/** The search-params implementations every encoding case runs against. */
const IMPLEMENTATIONS = [
    ['the minimal URLSearchParams', true] as const,
    ['the native URLSearchParams', false] as const,
];

/**
 * Install the minimal URLSearchParams when asked.
 */
function useSearchParams(minimal: boolean): void {
    if (minimal) {
        vi.stubGlobal('URLSearchParams', MinimalSearchParams);
    }
}

/**
 * Send a GET with a query and return the URL handed to fetch.
 */
async function sentUrl(query: QueryParameters): Promise<string> {
    const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () => Response.json({}));
    const client = new FetchHttpClient({ baseUrl: 'https://api.example.com', fetchFn });

    await client.get('/items', { query });

    return String(fetchFn.mock.calls[0]?.[0]);
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('FetchHttpClient - query encoding on a minimal URLSearchParams', () => {
    it.each(IMPLEMENTATIONS)('encodes a mixed query in order with %s', async (_case, minimal) => {
        useSearchParams(minimal);

        const url = await sentUrl({
            'q x': 'a b&c=d+e',
            name: 'café ☕',
            marks: "!'()~*",
            flag: true,
            n: 42,
            skipped: undefined,
        });

        expect(url).toBe(
            'https://api.example.com/items?q+x=a+b%26c%3Dd%2Be&name=caf%C3%A9+%E2%98%95&marks=%21%27%28%29%7E*&flag=true&n=42',
        );
    });

    const surrogates = [
        ['a lone high surrogate', 'a\uD800', 'a%EF%BF%BD'],
        ['a lone low surrogate', '\uDC00b', '%EF%BF%BDb'],
        ['a valid pair', '😀', '%F0%9F%98%80'],
        ['lone surrogates around a valid pair', '\uD800😀\uDC00', '%EF%BF%BD%F0%9F%98%80%EF%BF%BD'],
        ['a reversed pair', '\uDC00\uD800', '%EF%BF%BD%EF%BF%BD'],
        ['a repeated high surrogate', '\uD800\uD800', '%EF%BF%BD%EF%BF%BD'],
    ] as const;

    it.each(
        IMPLEMENTATIONS.flatMap(([name, minimal]) =>
            surrogates.map(([label, raw, encoded]) => [label, name, raw, encoded, minimal] as const),
        ),
    )('encodes %s in a value and a key with %s', async (_case, _implementation, raw, encoded, minimal) => {
        useSearchParams(minimal);

        expect(await sentUrl({ term: raw })).toBe(`https://api.example.com/items?term=${encoded}`);
        expect(await sentUrl({ [raw]: 'v' })).toBe(`https://api.example.com/items?${encoded}=v`);
    });
});

describe('ApiQuery - serialisation on a minimal URLSearchParams', () => {
    it('serialises a full query exactly as the native URLSearchParams does', () => {
        const query = ApiQuery.create()
            .where('name', 'R&D + 50% #1 café')
            .whereIn('status', ['open', 'a=b&c'])
            .whereRelation('author', author => author.where('email', '$neq', '%@example.com'))
            .orderBy('created_at', 'desc')
            .fieldsFor('posts', ['id', 'title'])
            .aggregatesFor('posts', ['comments_count'])
            .search('tea & cakes')
            .limit(25)
            .page(2);
        const native = query.toQueryString();

        useSearchParams(true);

        const minimal = query.toQueryString();

        expect(minimal).toBe(native);
        expect(minimal).toBe(
            'filters=%7B%22name%22%3A%22R%26D+%2B+50%25+%231+caf%C3%A9%22%2C%22status%22%3A%7B%22%24in%22%3A%5B%22open%22%2C%22a%3Db%26c%22%5D%7D%2C%22author%22%3A%7B%22email%22%3A%7B%22%24neq%22%3A%22%25%40example.com%22%7D%7D%7D&search=tea+%26+cakes&order=created_at%3Adesc&page=2&limit=25&fields%5Bposts%5D=id%2Ctitle&aggregates%5Bposts%5D=comments_count',
        );
    });
});

describe('FetchHttpClient - abort classification without abort reasons', () => {
    /**
     * A fetch that rejects with an AbortError once its signal aborts.
     */
    function hangUntilAborted(_input: FetchArgs[0], init?: RequestInit): Promise<Response> {
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
        });
    }

    it('classifies a timeout as a TimeoutError', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('AbortController', ReasonlessAbortController);

        const client = new FetchHttpClient({
            baseUrl: 'https://api.example.com',
            fetchFn: hangUntilAborted,
            timeout: 1_000,
        });
        const pending = client.get('/items').catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(await pending).toBeInstanceOf(TimeoutError);
    });

    it('classifies a caller abort as a CancelledError', async () => {
        vi.stubGlobal('AbortController', ReasonlessAbortController);

        const caller = new ReasonlessAbortController();
        const fetchFn = vi.fn(hangUntilAborted);
        const client = new FetchHttpClient({ baseUrl: 'https://api.example.com', fetchFn, timeout: 1_000 });
        const pending = client
            .get('/items', { signal: caller.signal as unknown as AbortSignal })
            .catch((error: unknown) => error);

        await vi.waitFor(() => {
            expect(fetchFn).toHaveBeenCalledOnce();
        });
        caller.abort();

        const error = await pending;

        expect(error).toBeInstanceOf(CancelledError);
        expect((error as CancelledError).cause).toBeInstanceOf(DOMException);
    });
});
