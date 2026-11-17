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

    describe.each(['track', 'page', 'identify'] as const)('%s', method => {
        it('logs the prefixed call', () => {
            new ConsoleAnalyticsTracker()[method]('subject');

            expect(infoSpy).toHaveBeenCalledWith(`[AnalyticsTracker] ${method}`, 'subject');
        });

        it('logs the attributes when given', () => {
            const attributes = { plan: 'pro' };

            new ConsoleAnalyticsTracker()[method]('subject', attributes);

            expect(infoSpy).toHaveBeenCalledWith(`[AnalyticsTracker] ${method}`, 'subject', attributes);
        });

        it('omits absent attributes', () => {
            new ConsoleAnalyticsTracker()[method]('subject');

            expect(infoSpy.mock.calls[0]).toHaveLength(2);
        });
    });

    describe('reset', () => {
        it('logs the prefixed call', () => {
            new ConsoleAnalyticsTracker().reset();

            expect(infoSpy).toHaveBeenCalledWith('[AnalyticsTracker] reset');
        });
    });
});
