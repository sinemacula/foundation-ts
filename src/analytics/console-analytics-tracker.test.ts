/**
 * Unit tests for console-analytics-tracker.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleAnalyticsTracker } from './console-analytics-tracker';

describe('ConsoleAnalyticsTracker', () => {
    let infoSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    });

    afterEach(() => {
        infoSpy.mockRestore();
    });

    describe('track', () => {
        it('calls console.info with the prefix, label and event name', () => {
            const tracker = new ConsoleAnalyticsTracker();

            tracker.track('button_clicked');

            expect(infoSpy).toHaveBeenCalledWith('[AnalyticsTracker] track', 'button_clicked');
        });

        it('calls console.info with properties when provided', () => {
            const tracker = new ConsoleAnalyticsTracker();
            const props = { label: 'submit' };

            tracker.track('button_clicked', props);

            expect(infoSpy).toHaveBeenCalledWith('[AnalyticsTracker] track', 'button_clicked', props);
        });

        it('does not pass a third argument when properties are omitted', () => {
            const tracker = new ConsoleAnalyticsTracker();

            tracker.track('event');

            expect(infoSpy.mock.calls[0]).toHaveLength(2);
        });
    });

    describe('page', () => {
        it('calls console.info with the prefix, label and page name', () => {
            const tracker = new ConsoleAnalyticsTracker();

            tracker.page('Home');

            expect(infoSpy).toHaveBeenCalledWith('[AnalyticsTracker] page', 'Home');
        });

        it('calls console.info with properties when provided', () => {
            const tracker = new ConsoleAnalyticsTracker();
            const props = { path: '/home' };

            tracker.page('Home', props);

            expect(infoSpy).toHaveBeenCalledWith('[AnalyticsTracker] page', 'Home', props);
        });

        it('does not pass a third argument when properties are omitted', () => {
            const tracker = new ConsoleAnalyticsTracker();

            tracker.page('Home');

            expect(infoSpy.mock.calls[0]).toHaveLength(2);
        });
    });

    describe('identify', () => {
        it('calls console.info with the prefix, label and user id', () => {
            const tracker = new ConsoleAnalyticsTracker();

            tracker.identify('user-42');

            expect(infoSpy).toHaveBeenCalledWith('[AnalyticsTracker] identify', 'user-42');
        });

        it('calls console.info with traits when provided', () => {
            const tracker = new ConsoleAnalyticsTracker();
            const traits = { plan: 'pro' };

            tracker.identify('user-42', traits);

            expect(infoSpy).toHaveBeenCalledWith('[AnalyticsTracker] identify', 'user-42', traits);
        });

        it('does not pass a third argument when traits are omitted', () => {
            const tracker = new ConsoleAnalyticsTracker();

            tracker.identify('user-42');

            expect(infoSpy.mock.calls[0]).toHaveLength(2);
        });
    });

    describe('reset', () => {
        it('calls console.info with the prefix and label', () => {
            const tracker = new ConsoleAnalyticsTracker();

            tracker.reset();

            expect(infoSpy).toHaveBeenCalledWith('[AnalyticsTracker] reset');
        });
    });
});
