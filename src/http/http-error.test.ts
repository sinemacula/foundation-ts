/**
 * Unit tests for http-error.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { CancelledError, HttpError, HttpValidationError, NetworkError } from './http-error';

describe('CancelledError', () => {
    it('sets the name property to CancelledError', () => {
        const error = new CancelledError('cancelled');

        expect(error.name).toBe('CancelledError');
    });

    it('sets the message from the first argument', () => {
        const error = new CancelledError('cancelled');

        expect(error.message).toBe('cancelled');
    });

    it('is an instance of Error', () => {
        const error = new CancelledError('cancelled');

        expect(error).toBeInstanceOf(Error);
    });

    it('is an instance of CancelledError', () => {
        const error = new CancelledError('cancelled');

        expect(error).toBeInstanceOf(CancelledError);
    });

    it('is not an instance of NetworkError', () => {
        const error = new CancelledError('cancelled');

        expect(error).not.toBeInstanceOf(NetworkError);
    });

    it('stores the cause when options are provided', () => {
        const cause = new Error('root cause');
        const error = new CancelledError('cancelled', { cause });

        expect(error.cause).toBe(cause);
    });
});

describe('NetworkError', () => {
    it('sets the name property to NetworkError', () => {
        const error = new NetworkError('connection refused');

        expect(error.name).toBe('NetworkError');
    });

    it('sets the message from the first argument', () => {
        const error = new NetworkError('connection refused');

        expect(error.message).toBe('connection refused');
    });

    it('is an instance of Error', () => {
        const error = new NetworkError('oops');

        expect(error).toBeInstanceOf(Error);
    });

    it('is an instance of NetworkError', () => {
        const error = new NetworkError('oops');

        expect(error).toBeInstanceOf(NetworkError);
    });

    it('stores the cause when options are provided', () => {
        const cause = new Error('root cause');
        const error = new NetworkError('wrapped', { cause });

        expect(error.cause).toBe(cause);
    });
});

describe('HttpError', () => {
    it('sets the name property to HttpError', () => {
        const error = new HttpError(404, 'Not found');

        expect(error.name).toBe('HttpError');
    });

    it('exposes the status code', () => {
        const error = new HttpError(500, 'Internal server error');

        expect(error.status).toBe(500);
    });

    it('exposes the message', () => {
        const error = new HttpError(400, 'Bad request');

        expect(error.message).toBe('Bad request');
    });

    it('defaults payload to null when omitted', () => {
        const error = new HttpError(400, 'Bad request');

        expect(error.payload).toBeNull();
    });

    it('stores a provided payload', () => {
        const payload = { code: 'ERR_GONE' };
        const error = new HttpError(410, 'Gone', payload);

        expect(error.payload).toBe(payload);
    });

    it('is an instance of Error', () => {
        const error = new HttpError(404, 'Not found');

        expect(error).toBeInstanceOf(Error);
    });

    it('is an instance of HttpError', () => {
        const error = new HttpError(404, 'Not found');

        expect(error).toBeInstanceOf(HttpError);
    });
});

describe('HttpValidationError', () => {
    it('sets the name property to HttpValidationError', () => {
        const error = new HttpValidationError(422, 'Unprocessable', null, {});

        expect(error.name).toBe('HttpValidationError');
    });

    it('exposes the status code', () => {
        const error = new HttpValidationError(422, 'Unprocessable', null, {});

        expect(error.status).toBe(422);
    });

    it('exposes the message', () => {
        const error = new HttpValidationError(422, 'Validation failed', null, {});

        expect(error.message).toBe('Validation failed');
    });

    it('exposes the payload', () => {
        const payload = { raw: true };
        const error = new HttpValidationError(422, 'Unprocessable', payload, {});

        expect(error.payload).toBe(payload);
    });

    it('exposes the errors map', () => {
        const errors = { email: ['invalid'] };
        const error = new HttpValidationError(422, 'Unprocessable', null, errors);

        expect(error.errors).toStrictEqual(errors);
    });

    it('is an instance of Error', () => {
        const error = new HttpValidationError(422, 'Unprocessable', null, {});

        expect(error).toBeInstanceOf(Error);
    });

    it('is an instance of HttpError', () => {
        const error = new HttpValidationError(422, 'Unprocessable', null, {});

        expect(error).toBeInstanceOf(HttpError);
    });

    it('is an instance of HttpValidationError', () => {
        const error = new HttpValidationError(422, 'Unprocessable', null, {});

        expect(error).toBeInstanceOf(HttpValidationError);
    });
});
