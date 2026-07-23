/**
 * Unit tests for i18n-error.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { I18nError } from './i18n-error';

describe('I18nError', () => {
    it('sets the name property to I18nError', () => {
        const error = new I18nError('unknown locale');

        expect(error.name).toBe('I18nError');
    });

    it('sets the message from the first argument', () => {
        const error = new I18nError('unknown locale');

        expect(error.message).toBe('unknown locale');
    });

    it('is an instance of Error', () => {
        const error = new I18nError('unknown locale');

        expect(error).toBeInstanceOf(Error);
    });

    it('is an instance of I18nError', () => {
        const error = new I18nError('unknown locale');

        expect(error).toBeInstanceOf(I18nError);
    });

    it('stores the cause when options are provided', () => {
        const cause = new Error('root cause');
        const error = new I18nError('wrapped', { cause });

        expect(error.cause).toBe(cause);
    });
});
