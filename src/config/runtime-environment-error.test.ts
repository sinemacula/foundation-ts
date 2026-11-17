/**
 * Unit tests for runtime-environment-error.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { RuntimeEnvironmentError } from './runtime-environment-error';

describe('RuntimeEnvironmentError', () => {
    it('is a named Error carrying its message and cause', () => {
        const cause = new Error('underlying');
        const error = new RuntimeEnvironmentError('could not load', { cause });

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('RuntimeEnvironmentError');
        expect(error.message).toBe('could not load');
        expect(error.cause).toBe(cause);
    });
});
