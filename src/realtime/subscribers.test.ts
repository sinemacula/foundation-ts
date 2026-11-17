/**
 * Unit tests for the realtime subscriber registries.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import { SubscriberList as SharedSubscriberList } from '../support/subscriber-list';
import { EventSubscribers, SubscriberList } from './subscribers';

describe('SubscriberList', () => {
    it('is the shared support list', () => {
        expect(SubscriberList).toBe(SharedSubscriberList);
    });
});

describe('EventSubscribers', () => {
    it('delivers to the handlers of the requested event only', () => {
        const subscribers = new EventSubscribers<string>(vi.fn());
        const update = vi.fn();
        const other = vi.fn();

        subscribers.on('update', update);
        subscribers.on('other', other);
        subscribers.snapshot('update')?.('x');

        expect(update).toHaveBeenCalledExactlyOnceWith('x');
        expect(other).not.toHaveBeenCalled();
    });

    it('returns no delivery for an event without handlers', () => {
        expect(new EventSubscribers<string>(vi.fn()).snapshot('update')).toBeUndefined();
    });

    it('lists the live event names in first-registration order', () => {
        const subscribers = new EventSubscribers<string>(vi.fn());

        subscribers.on('b', vi.fn());
        subscribers.on('a', vi.fn());
        subscribers.on('b', vi.fn());

        expect(subscribers.events()).toEqual(['b', 'a']);
        expect(subscribers.has('a')).toBe(true);
        expect(subscribers.has('c')).toBe(false);
    });

    it('keeps an event while it still has a handler', () => {
        const subscribers = new EventSubscribers<string>(vi.fn());
        const kept = vi.fn();
        const unsubscribe = subscribers.on('update', vi.fn());

        subscribers.on('update', kept);
        unsubscribe();

        expect(subscribers.has('update')).toBe(true);

        subscribers.snapshot('update')?.('x');

        expect(kept).toHaveBeenCalledExactlyOnceWith('x');
    });

    it('drops an event once its last handler leaves', () => {
        const subscribers = new EventSubscribers<string>(vi.fn());

        subscribers.on('kept', vi.fn());

        const first = subscribers.on('churn', vi.fn());
        const second = subscribers.on('churn', vi.fn());

        first();
        second();

        expect(subscribers.has('churn')).toBe(false);
        expect(subscribers.events()).toEqual(['kept']);
        expect(subscribers.snapshot('churn')).toBeUndefined();
    });

    it('does not drop a newer list when an old unsubscribe is repeated', () => {
        const subscribers = new EventSubscribers<string>(vi.fn());
        const newer = vi.fn();
        const unsubscribeOld = subscribers.on('update', vi.fn());

        unsubscribeOld();
        subscribers.on('update', newer);
        unsubscribeOld();

        expect(subscribers.has('update')).toBe(true);

        subscribers.snapshot('update')?.('x');

        expect(newer).toHaveBeenCalledExactlyOnceWith('x');
    });

    it('calls a handler registered twice for one event once per registration', () => {
        const subscribers = new EventSubscribers<string>(vi.fn());
        const handler = vi.fn();

        subscribers.on('update', handler);
        subscribers.on('update', handler);
        subscribers.snapshot('update')?.('x');

        expect(handler).toHaveBeenCalledTimes(2);
    });

    it('stops a delivery once isLive is false', () => {
        const subscribers = new EventSubscribers<string>(vi.fn());
        const second = vi.fn();
        let live = true;

        subscribers.on('update', () => {
            live = false;
        });
        subscribers.on('update', second);
        subscribers.snapshot('update')?.('x', () => live);

        expect(second).not.toHaveBeenCalled();
    });

    it('reports a throwing handler', () => {
        const report = vi.fn();
        const failure = new Error('handler exploded');
        const subscribers = new EventSubscribers<string>(report);

        subscribers.on('update', () => {
            throw failure;
        });
        subscribers.snapshot('update')?.('x');

        expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    });
});
