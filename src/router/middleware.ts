/**
 * Route middleware contract and pipeline.
 *
 * Laravel-style navigation middleware: each route lists middleware, the
 * pipeline runs them in order, and the first non-`next` result short-circuits
 * navigation. Results are a discriminated union, never an imperative `next()`
 * callback. The pipeline is generic over the platform's route and location
 * types; each kernel binds them (vue-router on web).
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * The navigation being evaluated by a middleware pipeline.
 */
export interface MiddlewareContext<R> {
    /** The route being navigated to. */
    readonly to: R;

    /** The route being navigated from. */
    readonly from: R;
}

/**
 * Discriminated union describing a middleware pipeline decision.
 */
export type MiddlewareResult<L> =
    | {
          /** Discriminant marking a proceed decision. */
          readonly kind: 'next';
      }
    | {
          /** Discriminant marking a redirect decision. */
          readonly kind: 'redirect';

          /** The location to redirect the navigation to. */
          readonly to: L;
      };

/**
 * A single navigation guard unit.
 */
export interface RouteMiddleware<R, L> {
    /**
     * Inspect a navigation and decide whether it proceeds.
     *
     * @param context - the navigation being evaluated
     * @returns the middleware decision
     */
    handle(context: MiddlewareContext<R>): MiddlewareResult<L> | Promise<MiddlewareResult<L>>;
}

/**
 * Allow the navigation to proceed.
 *
 * @returns the `next` decision
 */
export function next(): {
    /** Discriminant marking a proceed decision. */
    readonly kind: 'next';
} {
    return { kind: 'next' };
}

/**
 * Redirect the navigation elsewhere.
 *
 * @param to - the redirect target
 * @returns the `redirect` decision
 */
export function redirect<L>(to: L): MiddlewareResult<L> {
    return { kind: 'redirect', to };
}

/**
 * Run middleware in order until one short-circuits.
 *
 * @param middleware - the middleware to run
 * @param context - the navigation being evaluated
 * @returns the first non-`next` decision, or `next` when all pass
 */
export async function runMiddlewarePipeline<R, L>(
    middleware: readonly RouteMiddleware<R, L>[],
    context: MiddlewareContext<R>,
): Promise<MiddlewareResult<L>> {
    for (const entry of middleware) {
        const result = await entry.handle(context);

        if (result.kind !== 'next') {
            return result;
        }
    }

    return next();
}
