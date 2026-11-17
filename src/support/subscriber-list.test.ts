/**
 * Unit tests for the subscriber list.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it, vi } from 'vitest';

import { SubscriberList } from './subscriber-list';

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
