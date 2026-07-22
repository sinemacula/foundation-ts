/**
 * Unit tests for foundation-boot-error.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { FoundationBootError } from './foundation-boot-error';

describe('FoundationBootError', () => {
    it('is an Error carrying the given message', () => {
        const error = new FoundationBootError('bad boot');

        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('bad boot');
    });

    it('names itself FoundationBootError', () => {
        expect(new FoundationBootError('x').name).toBe('FoundationBootError');
    });
});
