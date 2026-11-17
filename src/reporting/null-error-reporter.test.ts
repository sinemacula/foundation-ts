/**
 * Unit tests for null-error-reporter.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { NullErrorReporter } from './null-error-reporter';

describe('NullErrorReporter', () => {
    it.each<[string, (reporter: NullErrorReporter) => void]>([
        ['captureError', reporter => reporter.captureError(new Error('boom'))],
        ['captureError with context', reporter => reporter.captureError(new Error('boom'), { key: 'value' })],
        ['captureError with a non-Error value', reporter => reporter.captureError('string error')],
        ['captureMessage', reporter => reporter.captureMessage('hello')],
        ['captureMessage with context', reporter => reporter.captureMessage('hello', { extra: 1 })],
        ['setUser with a user', reporter => reporter.setUser({ id: '1', email: 'a@b.com', name: 'Alice' })],
        ['setUser with null', reporter => reporter.setUser(null)],
    ])('ignores %s', (_, call) => {
        expect(() => call(new NullErrorReporter())).not.toThrow();
    });
});
