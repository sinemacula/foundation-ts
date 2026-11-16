/**
 * Unit tests for the default refresh-failure classification.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { CancelledError, HttpError, NetworkError } from '../http/http-error';
import { SessionError } from './session-error';
import { classifyRefreshError } from './session-outcomes';

describe('classifyRefreshError', () => {
    it('treats a 401 as the server rejecting the refresh credential', () => {
        expect(classifyRefreshError(new HttpError(401, 'Unauthorized'))).toBe('rejected');
    });

    it.each([408, 429, 500, 502, 503, 599])('treats a %i as retryable', (status) => {
        expect(classifyRefreshError(new HttpError(status, 'Transient'))).toBe('retryable');
    });

    it.each([400, 403, 404, 409, 410, 422, 499])('treats a %i as a non-retryable failure', (status) => {
        expect(classifyRefreshError(new HttpError(status, 'Refused'))).toBe('failed');
    });

    it('treats a transport failure as retryable', () => {
        expect(classifyRefreshError(new NetworkError('offline'))).toBe('retryable');
    });

    it('treats a transport failure subclass, such as a timeout, as retryable', () => {
        /** A transport failure subclass. */
        class TimeoutError extends NetworkError {}

        expect(classifyRefreshError(new TimeoutError('timed out'))).toBe('retryable');
    });

    it('treats a cancellation as retryable', () => {
        expect(classifyRefreshError(new CancelledError('aborted'))).toBe('retryable');
    });

    it('treats a malformed response as a non-retryable failure', () => {
        expect(classifyRefreshError(new SessionError('malformed'))).toBe('failed');
    });

    it('treats an unknown failure as a non-retryable failure', () => {
        expect(classifyRefreshError(new Error('boom'))).toBe('failed');
        expect(classifyRefreshError('boom')).toBe('failed');
        expect(classifyRefreshError(null)).toBe('failed');
        expect(classifyRefreshError(undefined)).toBe('failed');
    });
});
