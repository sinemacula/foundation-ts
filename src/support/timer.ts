/**
 * Timer delay bounds shared by every scheduled wait.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/** The longest delay a timer honours; a longer one fires almost at once. */
export const MAX_TIMER_DELAY = 2_147_483_647;

/**
 * Cap a delay at {@link MAX_TIMER_DELAY}, so an oversized delay waits as long
 * as a timer can instead of firing almost at once. Only the upper bound is
 * applied.
 */
export function clampTimerDelay(delay: number): number {
    return Math.min(delay, MAX_TIMER_DELAY);
}
