/**
 * Colour-scheme state machine over injected OS-source and applier ports.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { COLOR_SCHEME_STORAGE_KEY, type ColorSchemePreference, type ResolvedColorScheme } from './color-scheme';
import type { KeyValueStorage } from '../storage/key-value-storage';

const DEFAULT_PREFERENCE: ColorSchemePreference = 'system';

/**
 * The OS colour-scheme source: whether the OS prefers dark, and a subscription
 * to OS-scheme changes.
 */
export interface SystemColorSchemeSource {
    /**
     * Whether the OS currently prefers a dark scheme.
     */
    prefersDark(): boolean;

    /**
     * Subscribe to OS-scheme changes.
     *
     * @returns an unsubscribe function
     */
    subscribe(cb: () => void): () => void;
}

/**
 * Applies a resolved scheme to the platform surface.
 */
export interface ColorSchemeApplier {
    /**
     * Apply the resolved scheme. `preference` distinguishes an explicit choice
     * from `system`, which platforms may surface differently.
     */
    apply(resolved: ResolvedColorScheme, preference: ColorSchemePreference): void;
}

/**
 * A listener notified when the resolved scheme changes.
 */
export type ColorSchemeListener = (resolved: ResolvedColorScheme, preference: ColorSchemePreference) => void;

/**
 * Construction options for {@link ColorSchemeService}.
 */
export interface ColorSchemeServiceOptions {
    /** Preference store; a failing read uses the default and reaches `onError`, a failing write throws. */
    readonly storage: KeyValueStorage;

    /** The OS scheme source. */
    readonly source: SystemColorSchemeSource;

    /** The applier that puts a resolved scheme on the platform surface. */
    readonly applier: ColorSchemeApplier;

    /** The storage key for the persisted preference. Defaults to `theme`. */
    readonly storageKey?: string;

    /** The preference used when nothing is stored. Defaults to `system`. */
    readonly defaultPreference?: ColorSchemePreference;

    /** Receives a synchronous listener throw or failed storage read, never a rejection; a throwing sink is ignored. */
    readonly onError?: (error: unknown) => void;
}

/**
 * Detects, persists and applies the active colour scheme.
 *
 * The service writes raw `light`, `dark` or `system` through the storage port
 * and never removes the key. Durable persistence depends on the adapter.
 * Missing or invalid stored values use the configured default without repairing
 * storage.
 */
export class ColorSchemeService {
    /** Backing store for the persisted preference. */
    readonly #storage: KeyValueStorage;

    /** The OS scheme source. */
    readonly #source: SystemColorSchemeSource;

    /** The applier that puts a resolved scheme on the platform surface. */
    readonly #applier: ColorSchemeApplier;

    /** The resolved storage key for the persisted preference. */
    readonly #storageKey: string;

    /** The preference used when nothing is stored. */
    readonly #defaultPreference: ColorSchemePreference;

    /** The registered resolved-scheme listeners. */
    readonly #listeners = new Set<ColorSchemeListener>();

    /** Receives a contained listener or storage-read failure. */
    readonly #onError: (error: unknown) => void;

    /** The current raw preference. */
    #preference: ColorSchemePreference;

    /** The current resolved scheme. */
    #resolved: ResolvedColorScheme;

    /** The OS-source unsubscribe, while started. */
    #unsubscribe: (() => void) | null = null;

    constructor(options: ColorSchemeServiceOptions) {
        this.#storage = options.storage;
        this.#source = options.source;
        this.#applier = options.applier;
        this.#storageKey = options.storageKey ?? COLOR_SCHEME_STORAGE_KEY;
        this.#defaultPreference = options.defaultPreference ?? DEFAULT_PREFERENCE;
        this.#onError = options.onError ?? (() => undefined);
        this.#preference = this.#readPreference();
        this.#resolved = this.#derive();
    }

    /**
     * The current raw preference.
     */
    preference(): ColorSchemePreference {
        return this.#preference;
    }

    /**
     * The current resolved scheme.
     */
    resolved(): ResolvedColorScheme {
        return this.#resolved;
    }

    /**
     * Apply the resolved scheme and begin tracking OS changes, notifying
     * listeners when the OS changed the scheme since it was last resolved. A
     * no-op while started; calling it after {@link dispose} starts again.
     */
    start(): void {
        if (this.#unsubscribe !== null) {
            return;
        }

        const previous = this.#resolved;

        this.#resolved = this.#derive();
        this.#applier.apply(this.#resolved, this.#preference);
        this.#unsubscribe = this.#source.subscribe(() => {
            this.#handleOsChange();
        });

        if (this.#resolved !== previous) {
            this.#notify();
        }
    }

    /**
     * Persist the user's preference, then apply it and notify listeners. A
     * failing write throws before any state changes.
     */
    setPreference(pref: ColorSchemePreference): void {
        this.#storage.set(this.#storageKey, pref);
        this.#preference = pref;
        this.#resolved = this.#derive();
        this.#applier.apply(this.#resolved, this.#preference);
        this.#notify();
    }

    /**
     * Subscribe to resolved-scheme changes.
     *
     * @returns an unsubscribe function
     */
    subscribe(listener: ColorSchemeListener): () => void {
        this.#listeners.add(listener);

        return () => {
            this.#listeners.delete(listener);
        };
    }

    /**
     * Stop tracking OS changes until the next {@link start}; idempotent.
     */
    dispose(): void {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
    }

    /**
     * Read the stored preference, or the default when absent, invalid or
     * unreadable.
     */
    #readPreference(): ColorSchemePreference {
        const stored = this.#readStored();

        if (stored === 'light' || stored === 'dark' || stored === 'system') {
            return stored;
        }

        return this.#defaultPreference;
    }

    /**
     * Read the raw stored value, reporting a failing read and treating it as
     * absent.
     */
    #readStored(): string | null {
        try {
            return this.#storage.get(this.#storageKey);
        } catch (error) {
            this.#report(error);

            return null;
        }
    }

    /**
     * Resolve the preference against the OS scheme.
     */
    #derive(): ResolvedColorScheme {
        if (this.#preference !== 'system') {
            return this.#preference;
        }

        return this.#source.prefersDark() ? 'dark' : 'light';
    }

    /**
     * Notify every registered listener of the current scheme, passing a
     * throwing listener's error to the `onError` sink.
     */
    #notify(): void {
        for (const listener of this.#listeners) {
            try {
                listener(this.#resolved, this.#preference);
            } catch (error) {
                this.#report(error);
            }
        }
    }

    /**
     * Pass a contained error to the `onError` sink, ignoring a throwing sink so
     * one failure never starves the remaining listeners.
     */
    #report(error: unknown): void {
        try {
            this.#onError(error);
        } catch {
            // The sink is the last resort; nothing is left to report to.
        }
    }

    /**
     * Re-resolve and re-apply when the OS scheme changes under `system`.
     */
    #handleOsChange(): void {
        if (this.#preference !== 'system') {
            return;
        }

        this.#resolved = this.#derive();
        this.#applier.apply(this.#resolved, this.#preference);
        this.#notify();
    }
}
