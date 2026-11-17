/**
 * Unit tests for query-error.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { QueryError } from './query-error';

describe('QueryError', () => {
    it('is named QueryError', () => {
        const error = new QueryError('malformed envelope');

        expect(error.name).toBe('QueryError');
    });

    it('carries the message', () => {
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

    it('carries the cause from the options', () => {
        const cause = new Error('root cause');
        const error = new QueryError('wrapped', { cause });

        expect(error.cause).toBe(cause);
    });
});
