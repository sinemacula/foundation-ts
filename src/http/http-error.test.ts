/**
 * Unit tests for http-error.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import {
    ApiErrorCode,
    CancelledError,
    HttpError,
    HttpValidationError,
    MaintenanceError,
    NetworkError,
    QueryTooExpensiveError,
    ResponseParseError,
    TimeoutError,
} from './http-error';

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

    it('defaults the code and title to null and stores provided ones', () => {
        const bare = new HttpValidationError(422, 'Unprocessable', null, {});
        const detailed = new HttpValidationError(422, 'Unprocessable', null, {}, { code: 10106, title: 'Invalid' });

        expect([bare.code, bare.title]).toStrictEqual([null, null]);
        expect([detailed.code, detailed.title]).toStrictEqual([10106, 'Invalid']);
    });
});

describe('HttpError details', () => {
    it('defaults the code and title to null when omitted', () => {
        const error = new HttpError(404, 'Not found');

        expect(error.code).toBeNull();
        expect(error.title).toBeNull();
    });

    it('stores the provided code and title', () => {
        const error = new HttpError(404, 'Not found', null, { code: ApiErrorCode.NotFound, title: 'Not Found' });

        expect(error.code).toBe(10103);
        expect(error.title).toBe('Not Found');
    });
});

describe('TimeoutError', () => {
    it('is a NetworkError named TimeoutError, never a CancelledError', () => {
        const cause = new Error('timer fired');
        const error = new TimeoutError('timed out', { cause });

        expect(error).toBeInstanceOf(NetworkError);
        expect(error).not.toBeInstanceOf(CancelledError);
        expect(error.name).toBe('TimeoutError');
        expect(error.message).toBe('timed out');
        expect(error.cause).toBe(cause);
    });
});

describe('ResponseParseError', () => {
    it('carries the status and cause and sits outside the transport and status hierarchies', () => {
        const cause = new SyntaxError('Unexpected token <');
        const error = new ResponseParseError(200, 'unparseable', { cause });

        expect(error.name).toBe('ResponseParseError');
        expect(error.status).toBe(200);
        expect(error.message).toBe('unparseable');
        expect(error.cause).toBe(cause);
        expect(error).not.toBeInstanceOf(NetworkError);
        expect(error).not.toBeInstanceOf(HttpError);
    });
});

describe('QueryTooExpensiveError', () => {
    it('is an HttpError named QueryTooExpensiveError carrying the cost meta', () => {
        const meta = { parameter: 'limit', pointer: 'limit', reason: 'limit', limit: 100, actual: 500 };
        const error = new QueryTooExpensiveError(422, 'Too expensive', { raw: true }, meta, { code: 10201 });

        expect(error).toBeInstanceOf(HttpError);
        expect(error).not.toBeInstanceOf(HttpValidationError);
        expect(error.name).toBe('QueryTooExpensiveError');
        expect(error.meta).toBe(meta);
        expect(error.payload).toStrictEqual({ raw: true });
        expect(error.code).toBe(10201);
        expect(error.title).toBeNull();
    });

    it('defaults the code to null when no details are given', () => {
        const meta = { parameter: 'limit', pointer: 'limit', reason: 'limit', limit: 100, actual: 500 };

        expect(new QueryTooExpensiveError(422, 'Too expensive', null, meta).code).toBeNull();
    });
});

describe('MaintenanceError', () => {
    it('is an HttpError named MaintenanceError', () => {
        const error = new MaintenanceError(503, 'Down for maintenance', null, { code: 10200, title: 'Maintenance' });

        expect(error).toBeInstanceOf(HttpError);
        expect(error.name).toBe('MaintenanceError');
        expect(error.status).toBe(503);
        expect(error.code).toBe(ApiErrorCode.MaintenanceMode);
        expect(error.title).toBe('Maintenance');
    });

    it('defaults the code and title to null when no details are given', () => {
        const error = new MaintenanceError(503, 'Down for maintenance', null);

        expect([error.code, error.title]).toStrictEqual([null, null]);
    });
});

describe('ApiErrorCode', () => {
    it('mirrors the API error envelope codes', () => {
        expect(ApiErrorCode).toStrictEqual({
            UnhandledError: 10001,
            BadRequest: 10100,
            Unauthenticated: 10101,
            Forbidden: 10102,
            NotFound: 10103,
            NotAllowed: 10104,
            TokenMismatch: 10105,
            InvalidInput: 10106,
            TooManyRequests: 10107,
            Conflict: 10108,
            Gone: 10109,
            PayloadTooLarge: 10110,
            Locked: 10111,
            ServiceUnavailable: 10112,
            HttpError: 10113,
            MaintenanceMode: 10200,
            QueryTooExpensive: 10201,
        });
    });
});
