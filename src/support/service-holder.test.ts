/**
 * Unit tests for service-holder.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { createServiceHolder } from './service-holder';
import { SupportError } from './support-error';

interface Widget {
    readonly label: string;
}

describe('createServiceHolder', () => {
    it('throws with the interpolated name when resolved before install', () => {
        const holder = createServiceHolder<Widget>('http client');

        expect(() => holder.resolve()).toThrow('http client accessed before initialisation');
    });

    it('interpolates a different name into the resolve error', () => {
        const holder = createServiceHolder<Widget>('toast service');

        expect(() => holder.resolve()).toThrow('toast service accessed before initialisation');
    });

    it('throws a SupportError when resolved before install', () => {
        const holder = createServiceHolder<Widget>('http client');

        expect(() => holder.resolve()).toThrow(SupportError);
    });

    it('reports not installed before install', () => {
        const holder = createServiceHolder<Widget>('http client');

        expect(holder.isInstalled()).toBe(false);
    });

    it('resolves the exact installed instance', () => {
        const holder = createServiceHolder<Widget>('http client');
        const widget: Widget = { label: 'first' };

        holder.install(widget);

        expect(holder.resolve()).toBe(widget);
    });

    it('reports installed after install', () => {
        const holder = createServiceHolder<Widget>('http client');

        holder.install({ label: 'first' });

        expect(holder.isInstalled()).toBe(true);
    });

    it('overwrites the previous instance on a second install', () => {
        const holder = createServiceHolder<Widget>('http client');
        const first: Widget = { label: 'first' };
        const second: Widget = { label: 'second' };

        holder.install(first);
        holder.install(second);

        expect(holder.resolve()).toBe(second);
    });

    it('stays installed across a second install', () => {
        const holder = createServiceHolder<Widget>('http client');

        holder.install({ label: 'first' });
        holder.install({ label: 'second' });

        expect(holder.isInstalled()).toBe(true);
    });

    it('resolves an installed null instance without throwing', () => {
        const holder = createServiceHolder<Widget | null>('http client');

        holder.install(null);

        expect(holder.resolve()).toBeNull();
        expect(holder.isInstalled()).toBe(true);
    });

    it('resolves an installed undefined instance without throwing', () => {
        const holder = createServiceHolder<Widget | undefined>('http client');

        holder.install(undefined);

        expect(holder.resolve()).toBeUndefined();
        expect(holder.isInstalled()).toBe(true);
    });

    it('throws again after reset', () => {
        const holder = createServiceHolder<Widget>('http client');

        holder.install({ label: 'first' });
        holder.reset();

        expect(() => holder.resolve()).toThrow('http client accessed before initialisation');
    });

    it('reports not installed after reset', () => {
        const holder = createServiceHolder<Widget>('http client');

        holder.install({ label: 'first' });
        holder.reset();

        expect(holder.isInstalled()).toBe(false);
    });

    it('resolves a freshly installed instance after reset', () => {
        const holder = createServiceHolder<Widget>('http client');
        const first: Widget = { label: 'first' };
        const second: Widget = { label: 'second' };

        holder.install(first);
        holder.reset();
        holder.install(second);

        expect(holder.resolve()).toBe(second);
    });

    it('keeps independent holders isolated from each other', () => {
        const first = createServiceHolder<Widget>('first service');
        const second = createServiceHolder<Widget>('second service');
        const widget: Widget = { label: 'first' };

        first.install(widget);

        expect(first.resolve()).toBe(widget);
        expect(second.isInstalled()).toBe(false);
        expect(() => second.resolve()).toThrow('second service accessed before initialisation');
    });
});
