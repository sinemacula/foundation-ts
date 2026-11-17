/**
 * Unit tests for null-analytics-tracker.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { NullAnalyticsTracker } from './null-analytics-tracker';

describe('NullAnalyticsTracker', () => {
    it.each<[string, (tracker: NullAnalyticsTracker) => void]>([
        ['track', tracker => tracker.track('button_clicked')],
        ['track with properties', tracker => tracker.track('button_clicked', { label: 'submit' })],
        ['page', tracker => tracker.page('/home')],
        ['page with properties', tracker => tracker.page('/home', { referrer: '/login' })],
        ['identify', tracker => tracker.identify('user-123')],
        ['identify with traits', tracker => tracker.identify('user-123', { plan: 'pro' })],
        ['reset', tracker => tracker.reset()],
    ])('ignores %s', (_, call) => {
        expect(() => call(new NullAnalyticsTracker())).not.toThrow();
    });
});
