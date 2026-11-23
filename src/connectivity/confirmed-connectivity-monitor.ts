/**
 * Connectivity confirmed by repeated reachability probes, so a weak network
 * never flips the published state on one failure or one success.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import type { RetryBackoff } from '../http/fetch-http-client';
import { ExponentialBackoff } from '../realtime/exponential-backoff';
import { SubscriberList } from '../support/subscriber-list';
import { clampTimerDelay } from '../support/timer';
import type { ConnectivityHandler, ConnectivityMonitor } from './connectivity-monitor';

/**
 * Check whether the network reaches its target. Anything but resolving true,
 * including a rejection, counts as unreachable; the signal aborts on timeout
 * and on stop.
 */
export type ReachabilityProbe = (signal: AbortSignal) => Promise<boolean>;

/**
 * Receives hints that the network was just seen reachable or unreachable.
 */
export interface ConnectivityHintSink {
    /**
     * Hint at reachability. A hint that disagrees with the published state
     * probes at once; it never changes the state by itself.
     */
    hint(reachable: boolean): void;
}

/** Construction options for {@link ConfirmedConnectivityMonitor}. */
export interface ConfirmedConnectivityMonitorOptions {
    /** The platform's own connectivity signal, used as hints and as the initial state. */
    readonly platform: ConnectivityMonitor;

    /** The reachability check whose results alone decide the state. */
    readonly probe: ReachabilityProbe;

    /** Milliseconds unreachable results must span before going offline. Defaults to 5000. */
    readonly offlineAfter?: number;

    /** Milliseconds reachable results must span before going back online. Defaults to 5000. */
    readonly onlineAfter?: number;

    /** Milliseconds between probes while a change is being confirmed. Defaults to 1500. */
    readonly probeInterval?: number;

    /** Milliseconds before a probe counts as unreachable. Defaults to 5000. */
    readonly probeTimeout?: number;

    /** Milliseconds between probes while online, so a silent loss is still found; Infinity disables. Defaults to 30000. */
    readonly heartbeatInterval?: number;

    /** Spaces probes while offline. Defaults to `new ExponentialBackoff({ initialDelay: 2000, jitter: 'equal' })`. */
    readonly recoveryBackoff?: RetryBackoff;

    /** Monotonic clock in milliseconds. Defaults to `performance.now`. */
    readonly now?: () => number;

    /** Receives an error thrown by a subscriber or the backoff; defaults to ignoring it. */
    readonly onError?: (error: unknown) => void;
}

/** A run of consecutive results disagreeing with the published state. */
interface Run {
    /** When the run's first result completed. */
    readonly since: number;

    /** When the run's latest result completed. */
    last: number;
}

/**
 * Publishes connectivity only once probes confirm it.
 *
 * A change needs at least two consecutive probe results that disagree with the
 * published state, spanning `offlineAfter` or `onlineAfter`; one agreeing
 * result discards the run, so an intermittent connection keeps its current
 * state. A run whose results are further apart than a probe cycle allows, as
 * when timers are throttled, starts again. The platform signal and {@link hint}
 * only bring the next probe forward. The initial state is the platform's,
 * unconfirmed.
 */
export class ConfirmedConnectivityMonitor implements ConnectivityMonitor, ConnectivityHintSink {
    /** The platform's connectivity signal. */
    readonly #platform: ConnectivityMonitor;

    /** The reachability check. */
    readonly #probe: ReachabilityProbe;

    /** The span confirming a loss. */
    readonly #offlineAfter: number;

    /** The span confirming a recovery. */
    readonly #onlineAfter: number;

    /** The delay between confirming probes. */
    readonly #probeInterval: number;

    /** The delay before a probe counts as unreachable. */
    readonly #probeTimeout: number;

    /** The delay between probes while online. */
    readonly #heartbeatInterval: number;

    /** The longest gap between results that still continues a run. */
    readonly #maxGap: number;

    /** Spaces probes while offline. */
    readonly #recoveryBackoff: RetryBackoff;

    /** The monotonic clock. */
    readonly #now: () => number;

    /** Receives subscriber and backoff errors. */
    readonly #onError: (error: unknown) => void;

    /** The subscribed handlers. */
    readonly #handlers: SubscriberList<boolean>;

    /** The published connectivity. */
    #online: boolean;

    /** Replaced on every stop, so a probe from an earlier run is ignored. */
    #lifecycle: object = {};

    /** Whether the monitor is observing. */
    #started: boolean = false;

    /** Aborts the probe in flight, or null when none is. */
    #inFlight: AbortController | null = null;

    /** The scheduled probe, or undefined when none is. */
    #timer: ReturnType<typeof setTimeout> | undefined;

    /** The results disagreeing with the published state, or null. */
    #run: Run | null = null;

    /** The recovery probes made since going offline. */
    #recoveryAttempt: number = 0;

    /**
     * Construct a stopped monitor at the platform's connectivity.
     *
     * @throws {RangeError} when a duration is negative or not a number, or the
     * probe interval or timeout is not finite
     */
    constructor(options: ConfirmedConnectivityMonitorOptions) {
        this.#platform = options.platform;
        this.#probe = options.probe;
        this.#offlineAfter = duration('offlineAfter', options.offlineAfter ?? 5_000);
        this.#onlineAfter = duration('onlineAfter', options.onlineAfter ?? 5_000);
        this.#probeInterval = finiteDuration('probeInterval', options.probeInterval ?? 1_500);
        this.#probeTimeout = finiteDuration('probeTimeout', options.probeTimeout ?? 5_000);
        this.#heartbeatInterval = duration('heartbeatInterval', options.heartbeatInterval ?? 30_000);
        this.#maxGap = 2 * (this.#probeInterval + this.#probeTimeout);
        this.#recoveryBackoff =
            options.recoveryBackoff ?? new ExponentialBackoff({ initialDelay: 2_000, jitter: 'equal' });
        this.#now = options.now ?? (() => performance.now());
        this.#onError = options.onError ?? (() => undefined);
        this.#handlers = new SubscriberList(this.#onError);
        this.#online = options.platform.online;

        options.platform.onChange(online => {
            this.hint(online);
        });
    }

    /**
     * The published connectivity.
     */
    get online(): boolean {
        return this.#online;
    }

    /**
     * Start the platform signal and probe at once; a no-op when started.
     */
    start(): void {
        if (this.#started) {
            return;
        }

        this.#started = true;
        this.#platform.start();
        this.#probeNow();
    }

    /**
     * Stop probing and the platform signal, keeping the published state and
     * discarding any unconfirmed change; a no-op when stopped. The probe in
     * flight is aborted last, so its listeners may start the monitor again.
     */
    stop(): void {
        if (!this.#started) {
            return;
        }

        const inFlight = this.#inFlight;

        this.#started = false;
        this.#lifecycle = {};
        this.#run = null;
        this.#inFlight = null;
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#platform.stop();
        inFlight?.abort();
    }

    /**
     * Subscribe to published changes.
     *
     * @returns an unsubscribe function
     */
    onChange(handler: ConnectivityHandler): () => void {
        return this.#handlers.add(handler);
    }

    /**
     * Probe at once when the hint disagrees with the published state and no
     * change is already being confirmed; ignored while stopped. Such a hint
     * also restarts the recovery backoff.
     */
    hint(reachable: boolean): void {
        if (!this.#started || this.#run !== null || reachable === this.#online) {
            return;
        }

        this.#recoveryAttempt = 0;
        this.#probeNow();
    }

    /**
     * Run a probe unless one is in flight, cancelling the scheduled one.
     */
    #probeNow(): void {
        if (this.#inFlight !== null) {
            return;
        }

        clearTimeout(this.#timer);
        this.#timer = undefined;

        const lifecycle = this.#lifecycle;
        const controller = new AbortController();

        this.#inFlight = controller;

        void this.#isReachable(controller).then(reachable => {
            if (lifecycle !== this.#lifecycle) {
                return;
            }

            this.#inFlight = null;
            this.#record(reachable);
            this.#scheduleNext(lifecycle);
        });
    }

    /**
     * Resolve one probe's result, settling as unreachable on a rejection, on
     * timeout or on abort even when the probe ignores its signal.
     */
    #isReachable(controller: AbortController): Promise<boolean> {
        const { signal } = controller;

        return new Promise(resolve => {
            const timer = setTimeout(() => {
                controller.abort();
            }, this.#probeTimeout);

            /** Settle as unreachable once the probe is aborted. */
            const onAbort = (): void => {
                settle(false);
            };

            /** Settle once, releasing the timer and the abort listener. */
            const settle = (reachable: boolean): void => {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                resolve(reachable);
            };

            signal.addEventListener('abort', onAbort);

            new Promise<boolean>(run => {
                run(this.#probe(signal));
            }).then(
                reachable => {
                    settle(reachable === true);
                },
                () => {
                    settle(false);
                },
            );
        });
    }

    /**
     * Fold a result into the run, publishing once it is confirmed.
     */
    #record(reachable: boolean): void {
        const now = this.#now();

        if (reachable === this.#online) {
            this.#run = null;

            return;
        }

        const run = this.#run;

        if (run === null || now - run.last > this.#maxGap) {
            this.#run = { since: now, last: now };

            return;
        }

        run.last = now;

        if (now - run.since < (reachable ? this.#onlineAfter : this.#offlineAfter)) {
            return;
        }

        this.#run = null;
        this.#online = reachable;
        this.#recoveryAttempt = 0;
        this.#handlers.emit(reachable);
    }

    /**
     * Schedule the next probe: soon while confirming a change, on the heartbeat
     * while online, and on the recovery backoff while offline; never with an
     * infinite delay. Nothing is scheduled once a subscriber or the error sink
     * has stopped the monitor or started a probe.
     *
     * @param lifecycle - the lifecycle the completed probe belongs to
     */
    #scheduleNext(lifecycle: object): void {
        const delay = this.#nextDelay();

        if (lifecycle !== this.#lifecycle || this.#inFlight !== null || delay === Number.POSITIVE_INFINITY) {
            return;
        }

        this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.#probeNow();
        }, clampTimerDelay(delay));
    }

    /**
     * The delay before the next probe, falling back to the heartbeat when the
     * recovery backoff throws.
     */
    #nextDelay(): number {
        if (this.#run !== null) {
            return this.#probeInterval;
        }

        if (this.#online) {
            return this.#heartbeatInterval;
        }

        try {
            return this.#recoveryBackoff.delayFor(this.#recoveryAttempt++);
        } catch (error) {
            this.#report(error);

            return this.#heartbeatInterval;
        }
    }

    /**
     * Pass an error to the sink, ignoring a throwing sink.
     */
    #report(error: unknown): void {
        try {
            this.#onError(error);
        } catch {
            // The sink is the last resort; nothing is left to report to.
        }
    }
}

/**
 * Validate a duration of at least zero; Infinity is allowed.
 *
 * @throws {RangeError} when the value is negative or not a number
 */
function duration(name: string, value: number): number {
    if (!(value >= 0)) {
        throw new RangeError(`The connectivity ${name} must be a number of at least 0, got ${String(value)}.`);
    }

    return value;
}

/**
 * Validate a finite duration of at least zero.
 *
 * @throws {RangeError} when the value is negative or not finite
 */
function finiteDuration(name: string, value: number): number {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`The connectivity ${name} must be a finite number of at least 0, got ${String(value)}.`);
    }

    return value;
}
