/**
 * Unit tests for the realtime subscriber registries.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import { EventSubscribers, SubscriberList } from './subscribers';

describe('SubscriberList', () => {
    describe('registration', () => {
        it('counts each registration, including a repeated handler', () => {
            const list = new SubscriberList<string>(vi.fn());
            const handler = vi.fn();

            list.add(handler);
            list.add(handler);

            expect(list.size).toBe(2);
        });

        it('calls a handler registered twice once per registration', () => {
            const list = new SubscriberList<string>(vi.fn());
            const handler = vi.fn();

            list.add(handler);
            list.add(handler);
            list.emit('x');

            expect(handler).toHaveBeenCalledTimes(2);
        });

        it('removes only its own registration, and a repeated unsubscribe is a no-op', () => {
            const list = new SubscriberList<string>(vi.fn());
            const handler = vi.fn();
            const unsubscribe = list.add(handler);

            list.add(handler);
            unsubscribe();
            unsubscribe();
            list.emit('x');

            expect(list.size).toBe(1);
            expect(handler).toHaveBeenCalledTimes(1);
        });
    });

    describe('snapshot()', () => {
        it('delivers to the registrations captured at call time, in registration order', () => {
            const list = new SubscriberList<string>(vi.fn());
            const calls: string[] = [];

            list.add(value => calls.push(`a:${value}`));
            list.add(value => calls.push(`b:${value}`));

            const deliver = list.snapshot();

            list.add(value => calls.push(`c:${value}`));
            deliver('x');

            expect(calls).toEqual(['a:x', 'b:x']);
        });

        it('skips a registration removed since the capture', () => {
            const list = new SubscriberList<string>(vi.fn());
            const removed = vi.fn();
            const kept = vi.fn();
            const unsubscribe = list.add(removed);

            list.add(kept);

            const deliver = list.snapshot();

            unsubscribe();
            deliver('x');

            expect(removed).not.toHaveBeenCalled();
            expect(kept).toHaveBeenCalledExactlyOnceWith('x');
        });

        it('checks isLive before every handler and stops once it is false', () => {
            const list = new SubscriberList<string>(vi.fn());
            let live = true;
            const first = vi.fn(() => {
                live = false;
            });
            const second = vi.fn();

            list.add(first);
            list.add(second);
            list.snapshot()('x', () => live);

            expect(first).toHaveBeenCalledOnce();
            expect(second).not.toHaveBeenCalled();
        });

        it('delivers nothing when isLive is false from the start', () => {
            const list = new SubscriberList<string>(vi.fn());
            const handler = vi.fn();

            list.add(handler);
            list.snapshot()('x', () => false);

            expect(handler).not.toHaveBeenCalled();
        });

        it('reports a throwing handler and still runs the rest', () => {
            const report = vi.fn();
            const failure = new Error('handler exploded');
            const list = new SubscriberList<string>(report);
            const after = vi.fn();

            list.add(() => {
                throw failure;
            });
            list.add(after);
            list.snapshot()('x');

            expect(report).toHaveBeenCalledExactlyOnceWith(failure);
            expect(after).toHaveBeenCalledExactlyOnceWith('x');
        });

        it('contains a throwing report', () => {
            const list = new SubscriberList<string>(() => {
                throw new Error('report exploded');
            });
            const after = vi.fn();

            list.add(() => {
                throw new Error('handler exploded');
            });
            list.add(after);

            expect(() => list.snapshot()('x')).not.toThrow();
            expect(after).toHaveBeenCalledOnce();
        });
    });

    describe('emit()', () => {
        it('queues an emission from inside a handler after the current one, with its own capture', () => {
            const list = new SubscriberList<number>(vi.fn());
            const calls: string[] = [];
            list.add(value => {
                calls.push(`a:${value}`);

                if (value === 1) {
                    list.emit(2);
                    list.add(next => calls.push(`late:${next}`));
                    list.emit(3);
                }
            });
            list.add(value => calls.push(`b:${value}`));
            list.emit(1);

            expect(calls).toEqual(['a:1', 'b:1', 'a:2', 'b:2', 'a:3', 'b:3', 'late:3']);
        });

        it('delivers synchronously again once an emission has drained', () => {
            const list = new SubscriberList<number>(vi.fn());
            const handler = vi.fn();

            list.add(handler);
            list.emit(1);
            list.emit(2);

            expect(handler.mock.calls).toEqual([[1], [2]]);
        });

        it('does not hand the in-flight value to a handler added during it', () => {
            const list = new SubscriberList<number>(vi.fn());
            const late = vi.fn();
            let added = false;

            list.add(() => {
                if (!added) {
                    added = true;
                    list.add(late);
                }
            });
            list.emit(1);

            expect(late).not.toHaveBeenCalled();

            list.emit(2);

            expect(late).toHaveBeenCalledExactlyOnceWith(2);
        });
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
