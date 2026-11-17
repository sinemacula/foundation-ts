/**
 * Bounded trail of the events leading up to an error, for reporter context.
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
     * Start an empty trail.
     *
     * @param capacity - maximum number of breadcrumbs to retain (default 50);
     * 0 records nothing
     * @param clock - epoch-millisecond timestamp source (default Date.now)
     * @throws {RangeError} when `capacity` is not a non-negative integer
     */
    constructor(capacity: number = DEFAULT_CAPACITY, clock: () => number = () => Date.now()) {
        if (!Number.isInteger(capacity) || capacity < 0) {
            throw new RangeError('The breadcrumb capacity must be a non-negative integer.');
        }

        this.#capacity = capacity;
        this.#clock = clock;
    }

    /**
     * Append a breadcrumb to the trail, evicting the oldest when at capacity.
     */
    add(breadcrumb: Breadcrumb): void {
        if (this.#capacity === 0) {
            return;
        }

        if (this.#entries.length >= this.#capacity) {
            this.#entries.shift();
        }

        this.#entries.push({ ...breadcrumb, timestamp: this.#clock() });
    }

    /**
     * Return a snapshot of the current trail, oldest entry first.
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
