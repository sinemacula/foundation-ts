/**
 * Unit tests for middleware.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import type { MiddlewareContext, MiddlewareResult, RouteMiddleware } from './middleware';
import { next, redirect, runMiddlewarePipeline } from './middleware';

/** A minimal route the pipeline passes through. */
interface StubRoute {
    /** The route path. */
    readonly path: string;
}

/** A named redirect target. */
interface NamedLocation {
    /** The route name. */
    readonly name: string;
}

/** A redirect target, as a path or a named route. */
type StubLocation = string | NamedLocation;

type StubMiddleware = RouteMiddleware<StubRoute, StubLocation>;

const context: MiddlewareContext<StubRoute> = {
    to: { path: '/to' },
    from: { path: '/from' },
};

describe('next', () => {
    it('returns a next result', () => {
        expect(next()).toStrictEqual({ kind: 'next' });
    });
});

describe('redirect', () => {
    it('returns a redirect to the given target', () => {
        expect(redirect('/login')).toStrictEqual({ kind: 'redirect', to: '/login' });
    });

    it('accepts an object target', () => {
        expect(redirect({ name: 'home' })).toStrictEqual({ kind: 'redirect', to: { name: 'home' } });
    });
});

describe('runMiddlewarePipeline', () => {
    it('returns next when the middleware list is empty', async () => {
        const result = await runMiddlewarePipeline<StubRoute, StubLocation>([], context);

        expect(result).toStrictEqual({ kind: 'next' });
    });

    it('returns next when all middleware return next', async () => {
        const firstMiddleware: StubMiddleware = { handle: vi.fn().mockResolvedValue(next()) };
        const secondMiddleware: StubMiddleware = { handle: vi.fn().mockResolvedValue(next()) };

        const result = await runMiddlewarePipeline([firstMiddleware, secondMiddleware], context);

        expect(result).toStrictEqual({ kind: 'next' });
        expect(firstMiddleware.handle).toHaveBeenCalledOnce();
        expect(secondMiddleware.handle).toHaveBeenCalledOnce();
    });

    it('returns the first non-next result and skips the rest', async () => {
        const redirectResult: MiddlewareResult<StubLocation> = redirect('/forbidden');
        const firstMiddleware: StubMiddleware = { handle: vi.fn().mockResolvedValue(next()) };
        const secondMiddleware: StubMiddleware = { handle: vi.fn().mockResolvedValue(redirectResult) };
        const thirdMiddleware: StubMiddleware = { handle: vi.fn().mockResolvedValue(next()) };

        const result = await runMiddlewarePipeline([firstMiddleware, secondMiddleware, thirdMiddleware], context);

        expect(result).toStrictEqual(redirectResult);
        expect(firstMiddleware.handle).toHaveBeenCalledOnce();
        expect(secondMiddleware.handle).toHaveBeenCalledOnce();
        expect(thirdMiddleware.handle).not.toHaveBeenCalled();
    });

    it('passes the context to each middleware', async () => {
        const firstMiddleware: StubMiddleware = { handle: vi.fn().mockResolvedValue(next()) };

        await runMiddlewarePipeline([firstMiddleware], context);

        expect(firstMiddleware.handle).toHaveBeenCalledWith(context);
    });

    it('awaits async middleware', async () => {
        const asyncMiddleware: StubMiddleware = {
            handle: async (): Promise<MiddlewareResult<StubLocation>> => {
                await Promise.resolve();

                return redirect('/async-target');
            },
        };

        const result = await runMiddlewarePipeline([asyncMiddleware], context);

        expect(result).toStrictEqual({ kind: 'redirect', to: '/async-target' });
    });

    it('short-circuits when the first middleware redirects', async () => {
        const redirectResult: MiddlewareResult<StubLocation> = redirect('/early');
        const firstMiddleware: StubMiddleware = { handle: vi.fn().mockResolvedValue(redirectResult) };
        const secondMiddleware: StubMiddleware = { handle: vi.fn().mockResolvedValue(next()) };

        const result = await runMiddlewarePipeline([firstMiddleware, secondMiddleware], context);

        expect(result).toStrictEqual(redirectResult);
        expect(secondMiddleware.handle).not.toHaveBeenCalled();
    });
});
