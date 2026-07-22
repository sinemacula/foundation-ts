/**
 * Unit tests for null-analytics-tracker.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { NullAnalyticsTracker } from './null-analytics-tracker';

describe('NullAnalyticsTracker', () => {
    it('does not throw when track is called without properties', () => {
        const tracker = new NullAnalyticsTracker();

        expect(() => tracker.track('button_clicked')).not.toThrow();
    });

    it('does not throw when track is called with properties', () => {
        const tracker = new NullAnalyticsTracker();

        expect(() => tracker.track('button_clicked', { label: 'submit' })).not.toThrow();
    });

    it('does not throw when page is called without properties', () => {
        const tracker = new NullAnalyticsTracker();

        expect(() => tracker.page('/home')).not.toThrow();
    });

    it('does not throw when page is called with properties', () => {
        const tracker = new NullAnalyticsTracker();

        expect(() => tracker.page('/home', { referrer: '/login' })).not.toThrow();
    });

    it('does not throw when identify is called without traits', () => {
        const tracker = new NullAnalyticsTracker();

        expect(() => tracker.identify('user-123')).not.toThrow();
    });

    it('does not throw when identify is called with traits', () => {
        const tracker = new NullAnalyticsTracker();

        expect(() => tracker.identify('user-123', { plan: 'pro' })).not.toThrow();
    });

    it('does not throw when reset is called', () => {
        const tracker = new NullAnalyticsTracker();

        expect(() => tracker.reset()).not.toThrow();
    });
});
