/**
 * Generic application-singleton holder with an explicit install/resolve
 * lifecycle.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { SupportError } from './support-error';

/**
 * A named slot for a single application-wide service instance.
 */
export interface ServiceHolder<T> {
    /**
     * Install the service instance, replacing any previously installed one.
     *
     * @param instance - the instance to hold
     */
    install(instance: T): void;

    /**
     * Return the installed instance.
     *
     * @returns the installed instance
     * @throws {@link SupportError} when nothing has been installed
     */
    resolve(): T;

    /**
     * Clear the holder back to its uninstalled state. Test-only.
     */
    reset(): void;

    /**
     * Determine whether an instance is currently installed.
     *
     * @returns true when an instance is installed
     */
    isInstalled(): boolean;
}

/**
 * Create a service holder for the named singleton.
 *
 * @param name - human-readable service name used in the resolve error
 * @returns a fresh, uninstalled holder
 */
export function createServiceHolder<T>(name: string): ServiceHolder<T> {
    let instance: T | undefined;
    let installed = false;

    return {
        install(next: T): void {
            instance = next;
            installed = true;
        },
        resolve(): T {
            if (!installed) {
                throw new SupportError(`${name} accessed before initialisation`);
            }

            return instance as T;
        },
        reset(): void {
            instance = undefined;
            installed = false;
        },
        isInstalled(): boolean {
            return installed;
        },
    };
}
