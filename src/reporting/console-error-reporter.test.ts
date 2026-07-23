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
        it('calls console.error with the prefix and error', () => {
            const reporter = new ConsoleErrorReporter();
            const error = new Error('boom');

            reporter.captureError(error);

            expect(errorSpy).toHaveBeenCalledWith('[ErrorReporter]', error);
        });

        it('calls console.error with context when provided', () => {
            const reporter = new ConsoleErrorReporter();
            const error = new Error('oops');
            const context = { userId: '42' };

            reporter.captureError(error, context);

            expect(errorSpy).toHaveBeenCalledWith('[ErrorReporter]', error, context);
        });

        it('calls console.error without context argument when context is omitted', () => {
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
        it('calls console.warn with the prefix and message', () => {
            const reporter = new ConsoleErrorReporter();

            reporter.captureMessage('test message');

            expect(warnSpy).toHaveBeenCalledWith('[ErrorReporter]', 'test message');
        });

        it('calls console.warn with context when provided', () => {
            const reporter = new ConsoleErrorReporter();
            const context = { page: '/home' };

            reporter.captureMessage('navigation error', context);

            expect(warnSpy).toHaveBeenCalledWith('[ErrorReporter]', 'navigation error', context);
        });

        it('calls console.warn without context argument when context is omitted', () => {
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
        it('does not call console.error or console.warn when user is provided', () => {
            const reporter = new ConsoleErrorReporter();

            reporter.setUser({ id: '1', email: 'a@b.com', name: 'Alice' });

            expect(errorSpy).not.toHaveBeenCalled();
            expect(warnSpy).not.toHaveBeenCalled();
        });

        it('does not call console.error or console.warn when user is null', () => {
            const reporter = new ConsoleErrorReporter();

            reporter.setUser(null);

            expect(errorSpy).not.toHaveBeenCalled();
            expect(warnSpy).not.toHaveBeenCalled();
        });
    });
});
