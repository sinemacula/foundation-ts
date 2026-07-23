/**
 * Unit tests for query-error.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { QueryError } from './query-error';

describe('QueryError', () => {
    it('sets the name property to QueryError', () => {
        const error = new QueryError('malformed envelope');

        expect(error.name).toBe('QueryError');
    });

    it('sets the message from the first argument', () => {
        const error = new QueryError('malformed envelope');

        expect(error.message).toBe('malformed envelope');
    });

    it('is an instance of Error', () => {
        const error = new QueryError('malformed envelope');

        expect(error).toBeInstanceOf(Error);
    });

    it('is an instance of QueryError', () => {
        const error = new QueryError('malformed envelope');

        expect(error).toBeInstanceOf(QueryError);
    });

    it('stores the cause when options are provided', () => {
        const cause = new Error('root cause');
        const error = new QueryError('wrapped', { cause });

        expect(error.cause).toBe(cause);
    });
});
