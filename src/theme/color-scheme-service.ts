/**
 * Colour-scheme state machine.
 *
 * Resolves the active scheme from a stored preference (or the OS when
 * `system`), applies it through the platform applier, and tracks OS changes
 * while the preference is `system`. The OS source and the applier are injected
 * ports, so the state machine is framework- and DOM-free (matchMedia + DOM
 * stamping on web, Appearance + a native applier on mobile).
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
     * @param cb - invoked when the OS scheme changes
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
     * from `system` (which platforms may surface differently).
     *
     * @param resolved - the concrete scheme to apply
     * @param preference - the raw preference behind it
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
    /** Backing store for the persisted preference. */
    readonly storage: KeyValueStorage;

    /** The OS scheme source. */
    readonly source: SystemColorSchemeSource;

    /** The applier that puts a resolved scheme on the platform surface. */
    readonly applier: ColorSchemeApplier;

    /** The storage key for the persisted preference. Defaults to `theme`. */
    readonly storageKey?: string;

    /** The preference used when nothing is stored. Defaults to `system`. */
    readonly defaultPreference?: ColorSchemePreference;
}

/**
 * Detects, persists and applies the active colour scheme.
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

    /** The current raw preference. */
    #preference: ColorSchemePreference;

    /** The current resolved scheme. */
    #resolved: ResolvedColorScheme;

    /** The OS-source unsubscribe, when tracking. */
    #unsubscribe: (() => void) | null = null;

    /** Whether {@link start} has run. */
    #started = false;

    constructor(options: ColorSchemeServiceOptions) {
        this.#storage = options.storage;
        this.#source = options.source;
        this.#applier = options.applier;
        this.#storageKey = options.storageKey ?? COLOR_SCHEME_STORAGE_KEY;
        this.#defaultPreference = options.defaultPreference ?? DEFAULT_PREFERENCE;
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
     * Apply the resolved scheme and begin tracking OS changes.
     */
    start(): void {
        if (this.#started) {
            return;
        }

        this.#started = true;
        this.#resolved = this.#derive();
        this.#applier.apply(this.#resolved, this.#preference);
        this.#unsubscribe = this.#source.subscribe(() => {
            this.#handleOsChange();
        });
    }

    /**
     * Set the user's preference, persisting or clearing it.
     *
     * @param pref - the new preference
     */
    setPreference(pref: ColorSchemePreference): void {
        this.#preference = pref;

        if (pref === 'system') {
            this.#storage.remove(this.#storageKey);
        } else {
            this.#storage.set(this.#storageKey, pref);
        }

        this.#resolved = this.#derive();
        this.#applier.apply(this.#resolved, this.#preference);
        this.#notify();
    }

    /**
     * Subscribe to resolved-scheme changes.
     *
     * @param listener - the listener to notify
     * @returns an unsubscribe function
     */
    subscribe(listener: ColorSchemeListener): () => void {
        this.#listeners.add(listener);

        return () => {
            this.#listeners.delete(listener);
        };
    }

    /**
     * Stop tracking OS changes.
     */
    dispose(): void {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
    }

    /**
     * Read the stored preference, falling back to the default.
     *
     * @returns the stored preference, or the default when absent or invalid
     */
    #readPreference(): ColorSchemePreference {
        const stored = this.#storage.get(this.#storageKey);

        if (stored === 'light' || stored === 'dark' || stored === 'system') {
            return stored;
        }

        return this.#defaultPreference;
    }

    /**
     * Resolve the preference against the OS scheme.
     *
     * @returns the concrete scheme to apply
     */
    #derive(): ResolvedColorScheme {
        if (this.#preference !== 'system') {
            return this.#preference;
        }

        return this.#source.prefersDark() ? 'dark' : 'light';
    }

    /**
     * Notify every registered listener of the current scheme.
     */
    #notify(): void {
        for (const listener of this.#listeners) {
            listener(this.#resolved, this.#preference);
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
