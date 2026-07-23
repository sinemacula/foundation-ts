/**
 * Unit tests for session-error.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { SessionError } from './session-error';

describe('SessionError', () => {
    it('sets the name property to SessionError', () => {
        const error = new SessionError('bad session payload');

        expect(error.name).toBe('SessionError');
    });

    it('sets the message from the first argument', () => {
        const error = new SessionError('bad session payload');

        expect(error.message).toBe('bad session payload');
    });

    it('is an instance of Error', () => {
        const error = new SessionError('bad session payload');

        expect(error).toBeInstanceOf(Error);
    });

    it('is an instance of SessionError', () => {
        const error = new SessionError('bad session payload');

        expect(error).toBeInstanceOf(SessionError);
    });

    it('stores the cause when options are provided', () => {
        const cause = new Error('root cause');
        const error = new SessionError('wrapped', { cause });

        expect(error.cause).toBe(cause);
    });
});
