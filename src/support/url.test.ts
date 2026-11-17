/**
 * Unit tests for the URL helpers.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { stripQueryAndFragment } from './url';

describe('stripQueryAndFragment', () => {
    it.each([
        ['https://api.example.com/items', 'https://api.example.com/items'],
        ['https://api.example.com/reset?token=secret', 'https://api.example.com/reset'],
        ['https://api.example.com/callback#code=secret', 'https://api.example.com/callback'],
        ['https://api.example.com/a?b=1#c', 'https://api.example.com/a'],
        ['https://api.example.com/a#b?c=1', 'https://api.example.com/a'],
        ['', ''],
    ])('strips %s to %s', (url, expected) => {
        expect(stripQueryAndFragment(url)).toBe(expected);
    });
});
