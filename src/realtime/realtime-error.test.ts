/**
 * Unit tests for realtime-error.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { RealtimeError } from './realtime-error';

describe('RealtimeError', () => {
    it('sets the name property to RealtimeError', () => {
        const error = new RealtimeError('socket not open');

        expect(error.name).toBe('RealtimeError');
    });

    it('sets the message from the first argument', () => {
        const error = new RealtimeError('socket not open');

        expect(error.message).toBe('socket not open');
    });

    it('is an instance of Error', () => {
        const error = new RealtimeError('socket not open');

        expect(error).toBeInstanceOf(Error);
    });

    it('is an instance of RealtimeError', () => {
        const error = new RealtimeError('socket not open');

        expect(error).toBeInstanceOf(RealtimeError);
    });

    it('stores the cause when options are provided', () => {
        const cause = new Error('root cause');
        const error = new RealtimeError('wrapped', { cause });

        expect(error.cause).toBe(cause);
    });
});
