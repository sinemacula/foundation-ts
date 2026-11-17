/**
 * Subscriber registries shared by the realtime transport adapters.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { type SubscriberDelivery, SubscriberList } from '../support/subscriber-list';

export { type SubscriberDelivery, SubscriberList };

/**
 * Handlers keyed by event name, each name with its own {@link SubscriberList}.
 * A name is dropped once its last handler leaves.
 */
export class EventSubscribers<T> {
    /** Receives handler errors; a throwing sink is contained. */
    readonly #report: (error: unknown) => void;

    /** The live lists, keyed by event name. */
    readonly #lists: Map<string, SubscriberList<T>> = new Map();

    /**
     * Construct an empty registry.
     */
    constructor(report: (error: unknown) => void) {
        this.#report = report;
    }

    /**
     * Whether any handler is registered for `event`.
     */
    has(event: string): boolean {
        return this.#lists.has(event);
    }

    /**
     * The event names with at least one handler, in first-registration order.
     */
    events(): string[] {
        return [...this.#lists.keys()];
    }

    /**
     * Register a handler for `event`.
     *
     * @returns a function that removes this registration; repeating it is a
     * no-op
     */
    on(event: string, handler: (value: T) => void): () => void {
        const list = this.#lists.get(event) ?? new SubscriberList<T>(this.#report);

        this.#lists.set(event, list);

        const remove = list.add(handler);

        return () => {
            remove();

            // A stale closure must not drop a newer list for the same name.
            if (list.size === 0 && this.#lists.get(event) === list) {
                this.#lists.delete(event);
            }
        };
    }

    /**
     * Capture the current registrations for `event`.
     *
     * @returns the delivery, or undefined when nothing is registered
     */
    snapshot(event: string): SubscriberDelivery<T> | undefined {
        return this.#lists.get(event)?.snapshot();
    }
}
