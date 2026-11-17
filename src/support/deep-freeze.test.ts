/**
 * Unit tests for deep-freeze.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { deepFreeze } from './deep-freeze';

/** A node that refers back to itself. */
interface SelfReferencingNode {
    /** The node's own label. */
    readonly name: string;

    /** The node itself, once linked. */
    self?: SelfReferencingNode;
}

/** One half of a mutually referencing pair. */
interface PairedNode {
    /** The node's own label. */
    readonly name: string;

    /** The other node of the pair, once linked. */
    partner?: PairedNode;
}

describe('deepFreeze', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([42, 'hello', true, null, undefined])('returns %s unchanged', value => {
        expect(deepFreeze(value)).toBe(value);
    });

    it('freezes a flat object', () => {
        const obj = { a: 1, b: 'two' };

        deepFreeze(obj);

        expect(Object.isFrozen(obj)).toBe(true);
    });

    it('returns the same object reference', () => {
        const obj = { x: 1 };
        const result = deepFreeze(obj);

        expect(result).toBe(obj);
    });

    it('freezes nested objects recursively', () => {
        const inner = { c: 3 };
        const outer = { a: 1, nested: inner };

        deepFreeze(outer);

        expect(Object.isFrozen(outer)).toBe(true);
        expect(Object.isFrozen(inner)).toBe(true);
    });

    it('freezes arrays and their object elements', () => {
        const item = { v: 1 };
        const arr = [item, 2, 'three'];

        deepFreeze(arr);

        expect(Object.isFrozen(arr)).toBe(true);
        expect(Object.isFrozen(item)).toBe(true);
    });

    it('freezes a parent whose child is already frozen', () => {
        const child = Object.freeze({ y: 99 });
        const parent = { child };

        deepFreeze(parent);

        expect(Object.isFrozen(parent)).toBe(true);
        expect(Object.isFrozen(child)).toBe(true);
    });

    it('freezes structures three levels deep', () => {
        const level3 = { deep: true };
        const level2 = { level3 };
        const level1 = { level2 };

        deepFreeze(level1);

        expect(Object.isFrozen(level1)).toBe(true);
        expect(Object.isFrozen(level2)).toBe(true);
        expect(Object.isFrozen(level3)).toBe(true);
    });

    it('freezes the mutable children of an already-frozen root', () => {
        const grandchild = { b: 2 };
        const child = { a: 1, grandchild };
        const root = Object.freeze({ child });

        deepFreeze(root);

        expect(Object.isFrozen(child)).toBe(true);
        expect(Object.isFrozen(grandchild)).toBe(true);
    });

    it('freezes below a frozen constant nested in an unfrozen tree', () => {
        const leaf = { retries: 3 };
        const constant = Object.freeze({ leaf });
        const tree = { api: { constant } };

        deepFreeze(tree);

        expect(Object.isFrozen(tree.api)).toBe(true);
        expect(Object.isFrozen(leaf)).toBe(true);
    });

    it('freezes a self-referencing node without overflowing', () => {
        const node: SelfReferencingNode = { name: 'api' };

        node.self = node;

        expect(deepFreeze(node)).toBe(node);
        expect(Object.isFrozen(node)).toBe(true);
    });

    it('freezes both nodes of a mutual cycle', () => {
        const first: PairedNode = { name: 'first' };
        const second: PairedNode = { name: 'second', partner: first };

        first.partner = second;

        deepFreeze({ first });

        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(second)).toBe(true);
    });

    it('freezes a subtree shared by two paths exactly once', () => {
        const shared = { leaf: { value: 1 } };
        const tree = { left: { shared }, right: { shared } };
        const freeze = vi.spyOn(Object, 'freeze');

        deepFreeze(tree);

        expect(freeze.mock.calls.filter(([frozen]) => frozen === shared)).toHaveLength(1);

        expect(Object.isFrozen(tree.left)).toBe(true);
        expect(Object.isFrozen(tree.right)).toBe(true);
        expect(Object.isFrozen(shared)).toBe(true);
        expect(Object.isFrozen(shared.leaf)).toBe(true);
    });

    it('leaves a function leaf unfrozen and callable', () => {
        /** Format a value as a tag. */
        const format = (value: number): string => `#${String(value)}`;
        const tree = { format };

        deepFreeze(tree);

        expect(Object.isFrozen(tree)).toBe(true);
        expect(Object.isFrozen(format)).toBe(false);
        expect(tree.format(7)).toBe('#7');
    });
});
