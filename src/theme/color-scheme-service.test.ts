/**
 * Unit tests for color-scheme-service.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import { ColorSchemeService } from './color-scheme-service';
import type { ColorSchemeApplier, SystemColorSchemeSource } from './color-scheme-service';
import { MemoryStorage } from '../storage/memory-storage';
import type { ColorSchemePreference, ResolvedColorScheme } from './color-scheme';

interface StubSource extends SystemColorSchemeSource {
    dark: boolean;
    subscribeCount: number;
    unsubscribeCount: number;
    fireChange(): void;
}

function makeSource(dark = false): StubSource {
    let cb: (() => void) | null = null;

    const source: StubSource = {
        dark,
        subscribeCount: 0,
        unsubscribeCount: 0,
        prefersDark: () => source.dark,
        subscribe(handler) {
            source.subscribeCount += 1;
            cb = handler;

            return () => {
                source.unsubscribeCount += 1;
                cb = null;
            };
        },
        fireChange() {
            cb?.();
        },
    };

    return source;
}

interface StubApplier extends ColorSchemeApplier {
    calls: Array<{ resolved: ResolvedColorScheme; preference: ColorSchemePreference }>;
}

function makeApplier(): StubApplier {
    const calls: StubApplier['calls'] = [];

    return {
        calls,
        apply(resolved, preference) {
            calls.push({ resolved, preference });
        },
    };
}

function makeService(options?: {
    dark?: boolean;
    initialStored?: string;
    storageKey?: string;
    defaultPreference?: ColorSchemePreference;
}): { service: ColorSchemeService; storage: MemoryStorage; source: StubSource; applier: StubApplier } {
    const storage = new MemoryStorage();

    if (options?.initialStored !== undefined) {
        storage.set(options.storageKey ?? 'theme', options.initialStored);
    }

    const source = makeSource(options?.dark ?? false);
    const applier = makeApplier();

    const service = new ColorSchemeService({
        storage,
        source,
        applier,
        ...(options?.storageKey !== undefined ? { storageKey: options.storageKey } : {}),
        ...(options?.defaultPreference !== undefined ? { defaultPreference: options.defaultPreference } : {}),
    });

    return { service, storage, source, applier };
}

describe('ColorSchemeService', () => {
    describe('preference', () => {
        it('defaults to system when storage is empty', () => {
            expect(makeService().service.preference()).toBe('system');
        });

        it('returns a stored light preference verbatim', () => {
            expect(makeService({ initialStored: 'light' }).service.preference()).toBe('light');
        });

        it('returns a stored dark preference verbatim', () => {
            expect(makeService({ initialStored: 'dark' }).service.preference()).toBe('dark');
        });

        it('returns a stored system preference verbatim', () => {
            expect(makeService({ initialStored: 'system' }).service.preference()).toBe('system');
        });

        it('returns a stored system preference over a differing default', () => {
            expect(makeService({ initialStored: 'system', defaultPreference: 'light' }).service.preference()).toBe('system');
        });

        it('falls back to the default when the stored value is garbage', () => {
            expect(makeService({ initialStored: 'purple' }).service.preference()).toBe('system');
        });

        it('honours a custom default preference', () => {
            expect(makeService({ defaultPreference: 'dark' }).service.preference()).toBe('dark');
        });
    });

    describe('resolved', () => {
        it('resolves system to dark under a dark OS', () => {
            expect(makeService({ dark: true }).service.resolved()).toBe('dark');
        });

        it('resolves system to light under a light OS', () => {
            expect(makeService({ dark: false }).service.resolved()).toBe('light');
        });

        it('keeps an explicit light choice under a dark OS', () => {
            expect(makeService({ initialStored: 'light', dark: true }).service.resolved()).toBe('light');
        });

        it('keeps an explicit dark choice under a light OS', () => {
            expect(makeService({ initialStored: 'dark', dark: false }).service.resolved()).toBe('dark');
        });
    });

    describe('start', () => {
        it('applies the resolved scheme for an explicit dark choice', () => {
            const { service, applier } = makeService({ initialStored: 'dark', dark: false });

            service.start();

            expect(applier.calls).toStrictEqual([{ resolved: 'dark', preference: 'dark' }]);
        });

        it('applies the OS-resolved scheme under system', () => {
            const { service, applier } = makeService({ dark: true });

            service.start();

            expect(applier.calls).toStrictEqual([{ resolved: 'dark', preference: 'system' }]);
        });

        it('recomputes the resolved scheme from the OS at start time', () => {
            const { service, source, applier } = makeService({ dark: false });

            source.dark = true;
            service.start();

            expect(service.resolved()).toBe('dark');
            expect(applier.calls.at(-1)?.resolved).toBe('dark');
        });

        it('subscribes to the OS source exactly once when called twice', () => {
            const { service, source } = makeService();

            service.start();
            service.start();

            expect(source.subscribeCount).toBe(1);
        });
    });

    describe('setPreference', () => {
        it('persists an explicit light choice, applies it and notifies', () => {
            const { service, storage, applier } = makeService({ dark: true });
            const listener = vi.fn();

            service.start();
            service.subscribe(listener);
            service.setPreference('light');

            expect(storage.get('theme')).toBe('light');
            expect(applier.calls.at(-1)).toStrictEqual({ resolved: 'light', preference: 'light' });
            expect(listener).toHaveBeenCalledWith('light', 'light');
        });

        it('removes the stored key and applies under system', () => {
            const { service, storage, applier } = makeService({ initialStored: 'dark', dark: false });
            const listener = vi.fn();

            service.start();
            service.subscribe(listener);
            service.setPreference('system');

            expect(storage.get('theme')).toBeNull();
            expect(applier.calls.at(-1)).toStrictEqual({ resolved: 'light', preference: 'system' });
            expect(listener).toHaveBeenCalledWith('light', 'system');
        });

        it('writes under a custom storage key', () => {
            const { service, storage } = makeService({ storageKey: 'ns.theme' });

            service.setPreference('dark');

            expect(storage.get('ns.theme')).toBe('dark');
            expect(storage.get('theme')).toBeNull();
        });

        it('reads back an explicit choice from a custom storage key', () => {
            expect(makeService({ storageKey: 'ns.theme', initialStored: 'dark' }).service.preference()).toBe('dark');
        });
    });

    describe('OS changes', () => {
        it('re-derives, applies and notifies while on system', () => {
            const { service, source, applier } = makeService({ dark: false });
            const listener = vi.fn();

            service.start();
            service.subscribe(listener);
            source.dark = true;
            source.fireChange();

            expect(service.resolved()).toBe('dark');
            expect(applier.calls.at(-1)).toStrictEqual({ resolved: 'dark', preference: 'system' });
            expect(listener).toHaveBeenCalledWith('dark', 'system');
        });

        it('ignores OS changes while an explicit choice is active', () => {
            const { service, source, applier } = makeService({ initialStored: 'light', dark: false });
            const listener = vi.fn();

            service.start();
            service.subscribe(listener);
            source.dark = true;
            source.fireChange();

            expect(service.resolved()).toBe('light');
            expect(applier.calls).toHaveLength(1);
            expect(listener).not.toHaveBeenCalled();
        });
    });

    describe('dispose', () => {
        it('unsubscribes so later OS changes are ignored', () => {
            const { service, source } = makeService({ dark: false });
            const listener = vi.fn();

            service.start();
            service.subscribe(listener);
            service.dispose();
            source.dark = true;
            source.fireChange();

            expect(source.unsubscribeCount).toBe(1);
            expect(service.resolved()).toBe('light');
            expect(listener).not.toHaveBeenCalled();
        });

        it('is a no-op before start', () => {
            const { service, source } = makeService();

            expect(() => service.dispose()).not.toThrow();
            expect(source.unsubscribeCount).toBe(0);
        });
    });

    describe('subscribe', () => {
        it('returns an unsubscribe that stops later notifications', () => {
            const { service } = makeService({ dark: false });
            const listener = vi.fn();

            const unsubscribe = service.subscribe(listener);

            unsubscribe();
            service.setPreference('dark');

            expect(listener).not.toHaveBeenCalled();
        });
    });
});
