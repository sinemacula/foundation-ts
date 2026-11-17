/**
 * RealtimeConnection lifecycle contract, run by every transport adapter suite.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { ExponentialBackoff } from '../exponential-backoff';
import type { RealtimeConnection } from '../realtime-connection';
import type { BeforeReconnectHook } from '../reconnect';
import { defineRealtimeContractCases } from './realtime-contract-cases';

/** The contract-relevant construction options a harness forwards to its adapter. */
export interface ContractConnectionOptions {
    /** The endpoint URL, or a function resolved on every connect. */
    readonly url: string | (() => string);

    /** The backoff strategy spacing reconnect attempts. */
    readonly backoff?: ExponentialBackoff;

    /** Optional hook awaited before each reconnect attempt. */
    readonly beforeReconnect?: BeforeReconnectHook;

    /** Optional sink for the errors the connection contains. */
    readonly onError?: (error: unknown) => void;
}

/** One fake transport, adapted to a transport-agnostic surface. */
export interface ContractTransport {
    /** The URL the transport was opened with. */
    readonly url: string;

    /** How many times the transport was closed. */
    readonly closeCalls: number;

    /** Simulate the transport opening. */
    readonly open: () => void;

    /** Simulate the transport failing (an SSE error or a WebSocket close). */
    readonly fail: () => void;

    /** Simulate an incoming message for a named event. */
    readonly message: (event: string, data: string) => void;
}

/** A live view of the transports created so far; grows as reconnects open more. */
export interface ContractTransportRegistry {
    /** The number of transports created. */
    readonly length: number;

    /** The transport at the given index, or undefined when out of range. */
    readonly at: (index: number) => ContractTransport | undefined;
}

/** The adapter-specific hooks the contract is parameterised by. */
export interface RealtimeContractHarness {
    /**
     * Construct the adapter with a recording factory injected.
     *
     * @param options - the contract-relevant construction options
     * @returns the connection under test and its live transport registry
     */
    create(options: ContractConnectionOptions): {
        /** The connection under test. */
        connection: RealtimeConnection;

        /** The transports the adapter has opened, in creation order. */
        transports: ContractTransportRegistry;

        /** While set, the adapter's transport factory throws this error. */
        setFactoryError: (error: Error | null) => void;
    };
}

/**
 * Assert the shared RealtimeConnection lifecycle contract against one adapter.
 *
 * @param harness - the adapter-specific transport harness
 */
export function describeRealtimeContract(harness: RealtimeContractHarness): void {
    describe('RealtimeConnection contract', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        defineRealtimeContractCases({ describe, it }, harness);
    });
}
