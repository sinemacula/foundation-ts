/**
 * Unit tests for null-error-reporter.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { NullErrorReporter } from './null-error-reporter';

describe('NullErrorReporter', () => {
    it('does not throw when captureError is called with an Error', () => {
        const reporter = new NullErrorReporter();

        expect(() => reporter.captureError(new Error('boom'))).not.toThrow();
    });

    it('does not throw when captureError is called with context', () => {
        const reporter = new NullErrorReporter();

        expect(() => reporter.captureError(new Error('boom'), { key: 'value' })).not.toThrow();
    });

    it('does not throw when captureError is called with a non-Error value', () => {
        const reporter = new NullErrorReporter();

        expect(() => reporter.captureError('string error')).not.toThrow();
    });

    it('does not throw when captureMessage is called', () => {
        const reporter = new NullErrorReporter();

        expect(() => reporter.captureMessage('hello')).not.toThrow();
    });

    it('does not throw when captureMessage is called with context', () => {
        const reporter = new NullErrorReporter();

        expect(() => reporter.captureMessage('hello', { extra: 1 })).not.toThrow();
    });

    it('does not throw when setUser is called with a user', () => {
        const reporter = new NullErrorReporter();

        expect(() => reporter.setUser({ id: '1', email: 'a@b.com', name: 'Alice' })).not.toThrow();
    });

    it('does not throw when setUser is called with null', () => {
        const reporter = new NullErrorReporter();

        expect(() => reporter.setUser(null)).not.toThrow();
    });
});
