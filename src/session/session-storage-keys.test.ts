/**
 * Unit tests for the session storage keys.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_SESSION_STORAGE_KEYS } from './session-storage-keys';

describe('DEFAULT_SESSION_STORAGE_KEYS', () => {
    it('pins the exact versioned key strings live sessions persist under', () => {
        expect(DEFAULT_SESSION_STORAGE_KEYS).toStrictEqual({
            accessToken: 'auth.access_token',
            refreshToken: 'auth.refresh_token',
            expiresAt: 'auth.expires_at',
            deviceUuid: 'auth.device_uuid',
        });
    });
});
