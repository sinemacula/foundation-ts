/**
 * Bounded session breadcrumb trail.
 *
 * Records a finite sequence of events that led up to an error so that reporters
 * can attach them as context. The trail evicts the oldest entry whenever it
 * would exceed its capacity.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * A single trail entry before it is stamped with a timestamp.
 */
export interface Breadcrumb {
    /** The event category (e.g. navigation, click, request). */
    readonly category: string;

    /** A short description of the event. */
    readonly message: string;

    /** Optional structured data attached to the event. */
    readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * A breadcrumb that has been stored in the trail, extended with its timestamp.
 */
export interface RecordedBreadcrumb extends Breadcrumb {
    /** When the breadcrumb was recorded, in epoch milliseconds. */
    readonly timestamp: number;
}

const DEFAULT_CAPACITY = 50;

/**
 * A fixed-capacity FIFO queue of timestamped breadcrumbs.
 */
export class BreadcrumbTrail {
    /** Maximum number of breadcrumbs retained. */
    readonly #capacity: number;

    /** Timestamp source used to stamp each breadcrumb. */
    readonly #clock: () => number;

    /** The recorded breadcrumbs, oldest first. */
    #entries: RecordedBreadcrumb[] = [];

    /**
     * Start an empty trail bounded to a fixed capacity, timestamped by `clock`.
     *
     * @param capacity - maximum number of breadcrumbs to retain (default 50)
     * @param clock - timestamp source, injected for testability (default
     * Date.now)
     */
    constructor(capacity: number = DEFAULT_CAPACITY, clock: () => number = () => Date.now()) {
        this.#capacity = capacity;
        this.#clock = clock;
    }

    /**
     * Append a breadcrumb to the trail, evicting the oldest when at capacity.
     *
     * @param breadcrumb - the event to record
     */
    add(breadcrumb: Breadcrumb): void {
        if (this.#entries.length >= this.#capacity) {
            this.#entries.shift();
        }

        this.#entries.push({ ...breadcrumb, timestamp: this.#clock() });
    }

    /**
     * Return a read-only snapshot of the current trail, oldest entry first.
     *
     * @returns the recorded breadcrumbs
     */
    list(): readonly RecordedBreadcrumb[] {
        return [...this.#entries];
    }

    /**
     * Remove all breadcrumbs from the trail.
     */
    clear(): void {
        this.#entries = [];
    }
}
