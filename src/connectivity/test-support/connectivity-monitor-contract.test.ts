/**
 * Runs the ConnectivityMonitor contract against a reference monitor, which
 * validates the suite itself.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { ConnectivityHandler, ConnectivityMonitor } from '../connectivity-monitor';
import type { ConnectivityMonitorFixture } from './connectivity-monitor-contract';
import { describeConnectivityMonitorContract } from './connectivity-monitor-contract';

/** A platform's connectivity and the listener it emits to. */
interface Platform {
    /** The platform's connectivity. */
    online: boolean;

    /** The listener attached to the platform's events, or null. */
    listener: ((online: boolean) => void) | null;
}

/**
 * The smallest monitor meeting the contract.
 */
class ReferenceMonitor implements ConnectivityMonitor {
    /** The observed platform. */
    readonly #platform: Platform;

    /** The subscribed handlers. */
    readonly #handlers = new Set<ConnectivityHandler>();

    /** The connectivity last observed. */
    #online: boolean;

    constructor(platform: Platform) {
        this.#platform = platform;
        this.#online = platform.online;
    }

    /**
     * The connectivity last observed.
     */
    get online(): boolean {
        return this.#online;
    }

    /**
     * Attach to the platform and resample it.
     */
    start(): void {
        if (this.#platform.listener !== null) {
            return;
        }

        this.#platform.listener = online => {
            this.#observe(online);
        };
        this.#observe(this.#platform.online);
    }

    /**
     * Detach from the platform.
     */
    stop(): void {
        this.#platform.listener = null;
    }

    /**
     * Subscribe a handler.
     */
    onChange(handler: ConnectivityHandler): () => void {
        this.#handlers.add(handler);

        return () => {
            this.#handlers.delete(handler);
        };
    }

    /**
     * Record a connectivity, notifying the handlers when it changed.
     */
    #observe(online: boolean): void {
        if (online === this.#online) {
            return;
        }

        this.#online = online;

        for (const handler of this.#handlers) {
            handler(online);
        }
    }
}

describeConnectivityMonitorContract({
    create: (initial): ConnectivityMonitorFixture => {
        const platform: Platform = { online: initial, listener: null };

        return {
            monitor: new ReferenceMonitor(platform),
            report: online => {
                platform.online = online;
                platform.listener?.(online);
            },
        };
    },
});
