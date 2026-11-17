/**
 * Unit tests for console-error-reporter.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleErrorReporter } from './console-error-reporter';

describe('ConsoleErrorReporter', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
    });

    describe('captureError', () => {
        it('logs the error via console.error', () => {
            const reporter = new ConsoleErrorReporter();
            const error = new Error('boom');

            reporter.captureError(error);

            expect(errorSpy).toHaveBeenCalledWith('[ErrorReporter]', error);
        });

        it('logs the context when given', () => {
            const reporter = new ConsoleErrorReporter();
            const error = new Error('oops');
            const context = { userId: '42' };

            reporter.captureError(error, context);

            expect(errorSpy).toHaveBeenCalledWith('[ErrorReporter]', error, context);
        });

        it('omits absent context', () => {
            const reporter = new ConsoleErrorReporter();

            reporter.captureError('raw string');

            expect(errorSpy).toHaveBeenCalledWith('[ErrorReporter]', 'raw string');
            expect(errorSpy.mock.calls[0]).toHaveLength(2);
        });

        it('does not call console.warn', () => {
            const reporter = new ConsoleErrorReporter();

            reporter.captureError(new Error('x'));

            expect(warnSpy).not.toHaveBeenCalled();
        });
    });

    describe('captureMessage', () => {
        it('logs the message via console.warn', () => {
            const reporter = new ConsoleErrorReporter();

            reporter.captureMessage('test message');

            expect(warnSpy).toHaveBeenCalledWith('[ErrorReporter]', 'test message');
        });

        it('logs the context when given', () => {
            const reporter = new ConsoleErrorReporter();
            const context = { page: '/home' };

            reporter.captureMessage('navigation error', context);

            expect(warnSpy).toHaveBeenCalledWith('[ErrorReporter]', 'navigation error', context);
        });

        it('omits absent context', () => {
            const reporter = new ConsoleErrorReporter();

            reporter.captureMessage('bare message');

            expect(warnSpy).toHaveBeenCalledWith('[ErrorReporter]', 'bare message');
            expect(warnSpy.mock.calls[0]).toHaveLength(2);
        });

        it('does not call console.error', () => {
            const reporter = new ConsoleErrorReporter();

            reporter.captureMessage('msg');

            expect(errorSpy).not.toHaveBeenCalled();
        });
    });

    describe('setUser', () => {
        it('writes nothing for a user', () => {
            const reporter = new ConsoleErrorReporter();

            reporter.setUser({ id: '1', email: 'a@b.com', name: 'Alice' });

            expect(errorSpy).not.toHaveBeenCalled();
            expect(warnSpy).not.toHaveBeenCalled();
        });

        it('writes nothing when clearing the user', () => {
            const reporter = new ConsoleErrorReporter();

            reporter.setUser(null);

            expect(errorSpy).not.toHaveBeenCalled();
            expect(warnSpy).not.toHaveBeenCalled();
        });
    });
});
