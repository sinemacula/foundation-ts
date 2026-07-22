/**
 * Unit tests for middleware.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import type { MiddlewareContext, MiddlewareResult, RouteMiddleware } from './middleware';
import { next, redirect, runMiddlewarePipeline } from './middleware';

interface StubRoute {
    readonly path: string;
}

type StubLocation = string | { readonly name: string };

type StubMiddleware = RouteMiddleware<StubRoute, StubLocation>;

const context: MiddlewareContext<StubRoute> = {
    to: { path: '/to' },
    from: { path: '/from' },
};

describe('next', () => {
    it('returns a result with kind next', () => {
        expect(next()).toStrictEqual({ kind: 'next' });
    });
});

describe('redirect', () => {
    it('returns a result with kind redirect and the given target', () => {
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

    it('returns the first non-next result and stops calling later middleware', async () => {
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

    it('supports async middleware that return redirect', async () => {
        const asyncMiddleware: StubMiddleware = {
            handle: async (): Promise<MiddlewareResult<StubLocation>> => {
                await Promise.resolve();

                return redirect('/async-target');
            },
        };

        const result = await runMiddlewarePipeline([asyncMiddleware], context);

        expect(result).toStrictEqual({ kind: 'redirect', to: '/async-target' });
    });

    it('short-circuits immediately on the first middleware when it redirects', async () => {
        const redirectResult: MiddlewareResult<StubLocation> = redirect('/early');
        const firstMiddleware: StubMiddleware = { handle: vi.fn().mockResolvedValue(redirectResult) };
        const secondMiddleware: StubMiddleware = { handle: vi.fn().mockResolvedValue(next()) };

        const result = await runMiddlewarePipeline([firstMiddleware, secondMiddleware], context);

        expect(result).toStrictEqual(redirectResult);
        expect(secondMiddleware.handle).not.toHaveBeenCalled();
    });
});
