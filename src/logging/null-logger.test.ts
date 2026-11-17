/**
 * Unit tests for null-logger.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { NullLogger } from './null-logger';

describe('NullLogger', () => {
    it.each(['debug', 'info', 'warn', 'error'] as const)('ignores %s', level => {
        const logger = new NullLogger();

        expect(() => logger[level]('message')).not.toThrow();
        expect(() => logger[level]('message', { key: 'value' })).not.toThrow();
    });
});
