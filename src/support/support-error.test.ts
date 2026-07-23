/**
 * Unit tests for support-error.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { SupportError } from './support-error';

describe('SupportError', () => {
    it('sets the name property to SupportError', () => {
        const error = new SupportError('resolved before install');

        expect(error.name).toBe('SupportError');
    });

    it('sets the message from the first argument', () => {
        const error = new SupportError('resolved before install');

        expect(error.message).toBe('resolved before install');
    });

    it('is an instance of Error', () => {
        const error = new SupportError('resolved before install');

        expect(error).toBeInstanceOf(Error);
    });

    it('is an instance of SupportError', () => {
        const error = new SupportError('resolved before install');

        expect(error).toBeInstanceOf(SupportError);
    });

    it('stores the cause when options are provided', () => {
        const cause = new Error('root cause');
        const error = new SupportError('wrapped', { cause });

        expect(error.cause).toBe(cause);
    });
});
