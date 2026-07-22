/**
 * Unit tests for console-logger.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleLogger } from './console-logger';

describe('ConsoleLogger', () => {
    let infoSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        infoSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    describe('console targets', () => {
        it('writes debug via console.info', () => {
            const logger = new ConsoleLogger();

            logger.debug('debug message');

            expect(infoSpy).toHaveBeenCalledWith('[Logger:debug]', 'debug message');
        });

        it('writes info via console.info', () => {
            const logger = new ConsoleLogger();

            logger.info('info message');

            expect(infoSpy).toHaveBeenCalledWith('[Logger:info]', 'info message');
        });

        it('writes warn via console.warn', () => {
            const logger = new ConsoleLogger();

            logger.warn('warn message');

            expect(warnSpy).toHaveBeenCalledWith('[Logger:warn]', 'warn message');
        });

        it('writes error via console.error', () => {
            const logger = new ConsoleLogger();

            logger.error('error message');

            expect(errorSpy).toHaveBeenCalledWith('[Logger:error]', 'error message');
        });

        it('does not cross-write debug to console.warn or console.error', () => {
            const logger = new ConsoleLogger();

            logger.debug('debug message');

            expect(warnSpy).not.toHaveBeenCalled();
            expect(errorSpy).not.toHaveBeenCalled();
        });
    });

    describe('fields arity', () => {
        it('passes fields as a second console argument when provided', () => {
            const logger = new ConsoleLogger();
            const fields = { userId: '42' };

            logger.info('with fields', fields);

            expect(infoSpy).toHaveBeenCalledWith('[Logger:info]', 'with fields', fields);
        });

        it('omits the fields argument when not provided', () => {
            const logger = new ConsoleLogger();

            logger.info('no fields');

            expect(infoSpy).toHaveBeenCalledWith('[Logger:info]', 'no fields');
            expect(infoSpy.mock.calls[0]).toHaveLength(2);
        });
    });

    describe('level filtering', () => {
        it('writes every level when the minimum level defaults to debug', () => {
            const logger = new ConsoleLogger();

            logger.debug('d');
            logger.info('i');
            logger.warn('w');
            logger.error('e');

            expect(infoSpy).toHaveBeenCalledWith('[Logger:debug]', 'd');
            expect(infoSpy).toHaveBeenCalledWith('[Logger:info]', 'i');
            expect(warnSpy).toHaveBeenCalledWith('[Logger:warn]', 'w');
            expect(errorSpy).toHaveBeenCalledWith('[Logger:error]', 'e');
        });

        it('drops debug when the minimum level is info', () => {
            const logger = new ConsoleLogger('info');

            logger.debug('d');
            logger.info('i');

            expect(infoSpy).not.toHaveBeenCalledWith('[Logger:debug]', 'd');
            expect(infoSpy).toHaveBeenCalledWith('[Logger:info]', 'i');
        });

        it('drops debug and info when the minimum level is warn', () => {
            const logger = new ConsoleLogger('warn');

            logger.debug('d');
            logger.info('i');
            logger.warn('w');

            expect(infoSpy).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith('[Logger:warn]', 'w');
        });

        it('drops everything but error when the minimum level is error', () => {
            const logger = new ConsoleLogger('error');

            logger.debug('d');
            logger.info('i');
            logger.warn('w');
            logger.error('e');

            expect(infoSpy).not.toHaveBeenCalled();
            expect(warnSpy).not.toHaveBeenCalled();
            expect(errorSpy).toHaveBeenCalledWith('[Logger:error]', 'e');
        });
    });
});
