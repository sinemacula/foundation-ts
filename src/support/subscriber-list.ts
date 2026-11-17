/**
 * Ordered handler list with snapshot delivery, shared by every adapter that
 * notifies subscribers.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

/**
 * Delivers one value to the registrations captured by a snapshot.
 *
 * @param isLive - checked before every handler; delivery stops once it returns
 * false
 */
export type SubscriberDelivery<T> = (value: T, isLive?: () => boolean) => void;

/** One registration of a handler; the same handler may hold several. */
interface Registration<T> {
    /** The registered handler. */
    readonly handler: (value: T) => void;
}

/**
 * An ordered list of handlers for one kind of value.
 *
 * Every `add` is its own registration, removed only by its own unsubscribe.
 * Delivery runs over the registrations captured when it starts, in registration
 * order, skipping any removed since; a throwing handler goes to `report` and
 * the rest still run.
 */
export class SubscriberList<T> {
    /** Receives handler errors; a throwing sink is contained. */
    readonly #report: (error: unknown) => void;

    /** The live registrations, in registration order. */
    readonly #registrations: Set<Registration<T>> = new Set();

    /** Emissions waiting for the one in progress to finish. */
    readonly #queue: (() => void)[] = [];

    /** Whether an emission is being delivered. */
    #draining: boolean = false;

    /**
     * Construct an empty list.
     */
    constructor(report: (error: unknown) => void) {
        this.#report = report;
    }

    /**
     * The number of live registrations.
     */
    get size(): number {
        return this.#registrations.size;
    }

    /**
     * Register a handler.
     *
     * @returns a function that removes this registration; repeating it is a
     * no-op
     */
    add(handler: (value: T) => void): () => void {
        const registration: Registration<T> = { handler };

        this.#registrations.add(registration);

        return () => {
            this.#registrations.delete(registration);
        };
    }

    /**
     * Capture the current registrations for a later delivery.
     */
    snapshot(): SubscriberDelivery<T> {
        const captured = [...this.#registrations];

        return (value, isLive = () => true) => {
            for (const registration of captured) {
                if (!isLive()) {
                    return;
                }

                if (this.#registrations.has(registration)) {
                    this.#invoke(registration.handler, value);
                }
            }
        };
    }

    /**
     * Deliver a value to the current registrations. An emission from inside a
     * handler is captured at once and delivered after the current one.
     */
    emit(value: T): void {
        const deliver = this.snapshot();

        this.#queue.push(() => deliver(value));

        if (this.#draining) {
            return;
        }

        this.#draining = true;

        try {
            for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) {
                next();
            }
        } finally {
            this.#draining = false;
        }
    }

    /**
     * Call one handler, routing a throw to the report sink.
     */
    #invoke(handler: (value: T) => void, value: T): void {
        try {
            handler(value);
        } catch (error) {
            try {
                this.#report(error);
            } catch {
                // The sink is the last resort; nothing is left to report to.
            }
        }
    }
}
