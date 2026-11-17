/**
 * Unit tests for the URL helpers.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { encodeQuery, stripQueryAndFragment } from './url';

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

describe('encodeQuery', () => {
    it('encodes pairs in order, form-encoding keys and values', () => {
        expect(
            encodeQuery([
                ['q x', 'a b&c'],
                ['q x', '2'],
            ]),
        ).toBe('q+x=a+b%26c&q+x=2');
    });

    it('encodes no pairs as an empty string', () => {
        expect(encodeQuery([])).toBe('');
    });

    it.each([
        ['a lone high surrogate', 'a\uD800', 'a%EF%BF%BD'],
        ['a lone low surrogate', '\uDC00b', '%EF%BF%BDb'],
        ['a valid pair', '😀', '%F0%9F%98%80'],
        ['a reversed pair', '\uDC00\uD800', '%EF%BF%BD%EF%BF%BD'],
    ])('encodes %s in a key and a value', (_case, raw, encoded) => {
        expect(encodeQuery([[raw, raw]])).toBe(`${encoded}=${encoded}`);
    });
});
