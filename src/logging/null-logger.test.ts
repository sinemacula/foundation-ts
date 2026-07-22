/**
 * Unit tests for null-logger.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { NullLogger } from './null-logger';

describe('NullLogger', () => {
    it('does not throw when debug is called', () => {
        const logger = new NullLogger();

        expect(() => logger.debug('message')).not.toThrow();
    });

    it('does not throw when debug is called with fields', () => {
        const logger = new NullLogger();

        expect(() => logger.debug('message', { key: 'value' })).not.toThrow();
    });

    it('does not throw when info is called', () => {
        const logger = new NullLogger();

        expect(() => logger.info('message')).not.toThrow();
    });

    it('does not throw when info is called with fields', () => {
        const logger = new NullLogger();

        expect(() => logger.info('message', { key: 'value' })).not.toThrow();
    });

    it('does not throw when warn is called', () => {
        const logger = new NullLogger();

        expect(() => logger.warn('message')).not.toThrow();
    });

    it('does not throw when warn is called with fields', () => {
        const logger = new NullLogger();

        expect(() => logger.warn('message', { key: 'value' })).not.toThrow();
    });

    it('does not throw when error is called', () => {
        const logger = new NullLogger();

        expect(() => logger.error('message')).not.toThrow();
    });

    it('does not throw when error is called with fields', () => {
        const logger = new NullLogger();

        expect(() => logger.error('message', { key: 'value' })).not.toThrow();
    });
});
