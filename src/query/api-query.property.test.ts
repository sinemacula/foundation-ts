/**
 * Property tests that the filter tree ApiQuery emits selects exactly the rows
 * its calls describe, checked against a reference evaluator.
 *
 * @author      Ben Carey <bdmc@sinemacula.co.uk>
 * @copyright   2026 Sine Macula Limited
 */

import { describe, expect, it } from 'vitest';

import { isRecord } from '../support/is-record';
import { ApiQuery } from './api-query';
import type { FilterTree, ScalarOperator } from './filter-expression';

/** A column value: rows may hold null, operands never do. */
type Cell = 0 | 1 | 2 | null;

/** A non-null operand. */
type Operand = 0 | 1 | 2;

/** The enum-capability column. */
type EnumColumn = 'kind';

/** The range-capability column. */
type RangeColumn = 'rank';

/** Any column. */
type Column = EnumColumn | RangeColumn;

/** A to-one relation, present at every depth. */
type Relation = 'parent' | 'owner';

/** An equality, or a comparison when an operator is set. */
interface Comparison {
    /** The builder method. */
    readonly call: 'where';

    /** The compared column. */
    readonly column: Column;

    /** The operator, or null for the equality form. */
    readonly operator: ScalarOperator | null;

    /** The operand. */
    readonly value: Operand;
}

/** A membership condition. */
interface Membership {
    /** The builder method. */
    readonly call: 'whereIn';

    /** The compared column. */
    readonly column: Column;

    /** The accepted values. */
    readonly values: readonly Operand[];
}

/** An inclusive range condition. */
interface Range {
    /** The builder method. */
    readonly call: 'whereBetween';

    /** The compared column. */
    readonly column: RangeColumn;

    /** The lower bound. */
    readonly low: Operand;

    /** The upper bound. */
    readonly high: Operand;
}

/** A null or not-null condition. */
interface Nullness {
    /** The builder method. */
    readonly call: 'whereNull' | 'whereNotNull';

    /** The checked column. */
    readonly column: Column;
}

/** A relation condition, bare when it carries no body. */
interface RelationCall {
    /** The builder method. */
    readonly call: 'whereRelation' | 'whereHas' | 'whereHasNot';

    /** The relation. */
    readonly relation: Relation;

    /** The calls on the related row, or null for a bare existence check. */
    readonly body: readonly Operation[] | null;
}

/** A logical group of documents. */
interface Group {
    /** The builder method. */
    readonly call: 'andWhere' | 'orWhere';

    /** The calls building each document. */
    readonly documents: ReadonlyArray<readonly Operation[]>;
}

/** One call in a generated sequence, interpreted by both evaluators. */
type Operation = Comparison | Membership | Range | Nullness | RelationCall | Group;

/** A generated row whose relations are each zero or one related row. */
interface Row {
    /** The enum column. */
    readonly kind: Cell;

    /** The range column. */
    readonly rank: Cell;

    /** The first to-one relation. */
    readonly parent: Row | null;

    /** The second to-one relation. */
    readonly owner: Row | null;
}

/** The deepest nesting of relations and groups a sequence reaches. */
const MAX_DEPTH = 3;

/** The operators each column's capability admits in the operator form of where. */
const OPERATORS: Readonly<Record<Column, readonly ScalarOperator[]>> = {
    kind: ['$eq', '$neq'],
    rank: ['$eq', '$gt', '$ge', '$lt', '$le'],
};

/**
 * A seeded mulberry32 pseudo-random source.
 */
class Random {
    /** The generator state. */
    #state: number;

    constructor(seed: number) {
        this.#state = seed >>> 0;
    }

    /**
     * Return a float in [0, 1).
     */
    next(): number {
        this.#state = (this.#state + 0x6d2b79f5) >>> 0;
        let t = this.#state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    /**
     * Return an integer in [low, high].
     */
    between(low: number, high: number): number {
        return low + Math.floor(this.next() * (high - low + 1));
    }

    /**
     * Return one of `items`.
     */
    pick<Item>(items: readonly Item[]): Item {
        return items[this.between(0, items.length - 1)] as Item;
    }
}

/**
 * Generate a row whose relations reach down to `MAX_DEPTH`.
 */
function generateRow(rng: Random, depth = 0): Row {
    const cells = [0, 1, 2, null] as const;
    const [parent = null, owner = null] = [0, 1].map(() =>
        depth < MAX_DEPTH && rng.next() < 0.7 ? generateRow(rng, depth + 1) : null,
    );

    return { kind: rng.pick(cells), rank: rng.pick(cells), parent, owner };
}

/**
 * Generate between `low` and `high` operations at `depth`.
 */
function generateOperations(rng: Random, depth: number, low: number, high: number): Operation[] {
    return Array.from({ length: rng.between(low, high) }, () => generateOperation(rng, depth));
}

/**
 * Generate one operation at `depth`, nesting only while below `MAX_DEPTH`.
 */
function generateOperation(rng: Random, depth: number): Operation {
    const operands = [0, 1, 2] as const;
    const roll = rng.next();
    const column = rng.pick<Column>(['kind', 'rank']);
    const nested = depth < MAX_DEPTH;

    if (nested && roll < 0.25) {
        const call = rng.pick(['whereRelation', 'whereHas', 'whereHasNot'] as const);
        const bare = call !== 'whereRelation' && rng.next() < 0.3;

        return {
            call,
            relation: rng.pick(['parent', 'owner'] as const),
            body: bare ? null : generateOperations(rng, depth + 1, 0, 3),
        };
    }

    if (nested && roll < 0.4) {
        const documents = Array.from({ length: rng.between(1, 3) }, () => generateOperations(rng, depth + 1, 1, 2));

        return { call: rng.pick(['andWhere', 'orWhere'] as const), documents };
    }

    if (roll < 0.55) {
        return { call: 'whereIn', column, values: Array.from({ length: rng.between(1, 3) }, () => rng.pick(operands)) };
    }

    if (roll < 0.62) {
        return { call: 'whereBetween', column: 'rank', low: rng.pick(operands), high: rng.pick(operands) };
    }

    if (roll < 0.7) {
        return { call: rng.pick(['whereNull', 'whereNotNull'] as const), column };
    }

    return {
        call: 'where',
        column,
        operator: rng.next() < 0.3 ? null : rng.pick(OPERATORS[column]),
        value: rng.pick(operands),
    };
}

/**
 * Apply a sequence of operations to a query through the public builder.
 */
function build(query: ApiQuery, operations: readonly Operation[]): ApiQuery {
    return operations.reduce(apply, query);
}

/**
 * Apply one operation to a query through the public builder.
 */
function apply(query: ApiQuery, operation: Operation): ApiQuery {
    switch (operation.call) {
        case 'where':
            return operation.operator === null
                ? query.where(operation.column, operation.value)
                : query.where(operation.column, operation.operator, operation.value);
        case 'whereIn':
            return query.whereIn(operation.column, operation.values);
        case 'whereBetween':
            return query.whereBetween(operation.column, [operation.low, operation.high]);
        case 'whereNull':
        case 'whereNotNull':
            return query[operation.call](operation.column);
        case 'whereRelation':
            return query.whereRelation(operation.relation, q => build(q, operation.body ?? []));
        case 'whereHas':
        case 'whereHasNot': {
            const { body } = operation;

            return query[operation.call](operation.relation, body === null ? undefined : q => build(q, body));
        }
        case 'andWhere':
        case 'orWhere':
            return query[operation.call](operation.documents.map(document => (q: ApiQuery) => build(q, document)));
    }
}

/**
 * Determine whether a cell compares true against an operand; any comparison
 * with null is false.
 */
function satisfies(cell: Cell, operator: ScalarOperator, value: unknown): boolean {
    const operand = value as number;

    if (cell === null) {
        return false;
    }

    switch (operator) {
        case '$eq':
            return cell === operand;
        case '$neq':
            return cell !== operand;
        case '$gt':
            return cell > operand;
        case '$ge':
            return cell >= operand;
        case '$lt':
            return cell < operand;
        case '$le':
            return cell <= operand;
    }
}

/**
 * The reference meaning of a call sequence: the AND of every call.
 */
function holdsAll(operations: readonly Operation[], row: Row): boolean {
    return operations.every(operation => holds(operation, row));
}

/**
 * The reference meaning of one call, read from the operation alone.
 */
function holds(operation: Operation, row: Row): boolean {
    switch (operation.call) {
        case 'where':
            return satisfies(row[operation.column], operation.operator ?? '$eq', operation.value);
        case 'whereIn':
            return operation.values.some(value => satisfies(row[operation.column], '$eq', value));
        case 'whereBetween': {
            const cell = row[operation.column];

            return satisfies(cell, '$ge', operation.low) && satisfies(cell, '$le', operation.high);
        }
        case 'whereNull':
            return row[operation.column] === null;
        case 'whereNotNull':
            return row[operation.column] !== null;
        case 'whereRelation':
        case 'whereHas': {
            const related = row[operation.relation];

            return related !== null && holdsAll(operation.body ?? [], related);
        }
        case 'whereHasNot': {
            const related = row[operation.relation];

            return related === null || (operation.body !== null && !holdsAll(operation.body, related));
        }
        case 'andWhere':
            return operation.documents.every(document => holdsAll(document, row));
        case 'orWhere':
            return operation.documents.some(document => holdsAll(document, row));
    }
}

/**
 * Read a `$has` or `$hasnt` value as relation entries.
 */
function existence(value: unknown): Array<[string, unknown]> {
    return isRecord(value) ? Object.entries(value) : (value as string[]).map(relation => [relation, {}]);
}

/**
 * Evaluate an emitted filter document against a row, refusing anything outside
 * the grammar.
 */
function matches(document: unknown, row: Row): boolean {
    if (!isRecord(document)) {
        throw new Error(`Not a document: ${JSON.stringify(document)}`);
    }

    return Object.entries(document).every(([key, value]) => matchesEntry(key, value, row));
}

/**
 * Evaluate one key of an emitted filter document against a row.
 */
function matchesEntry(key: string, value: unknown, row: Row): boolean {
    switch (key) {
        case '$and':
            return (value as unknown[]).every(document => matches(document, row));
        case '$or':
            return (value as unknown[]).some(document => matches(document, row));
        case '$has':
            return existence(value).every(([relation, document]) => matchesEntry(relation, document, row));
        case '$hasnt':
            return existence(value).every(([relation, document]) => !matchesEntry(relation, document, row));
        case 'kind':
        case 'rank':
            return meetsCondition(row[key], value);
        case 'parent':
        case 'owner': {
            const related = row[key];

            return related !== null && matches(value, related);
        }
        default:
            throw new Error(`Unknown key: ${key}`);
    }
}

/**
 * Evaluate a column condition: a scalar equality or an operator map.
 */
function meetsCondition(cell: Cell, condition: unknown): boolean {
    if (!isRecord(condition)) {
        return satisfies(cell, '$eq', condition);
    }

    return Object.entries(condition).every(([operator, operand]) => {
        switch (operator) {
            case '$in':
                return (operand as unknown[]).some(value => satisfies(cell, '$eq', value));
            case '$between': {
                const [low, high] = operand as [number, number];

                return satisfies(cell, '$ge', low) && satisfies(cell, '$le', high);
            }
            case '$null':
                return cell === null;
            case '$notNull':
                return cell !== null;
            default:
                return satisfies(cell, operator as ScalarOperator, operand);
        }
    });
}

/**
 * Collect the structural defects of an emitted tree: an empty group, or an
 * `$and` document a bare `$hasnt` at the same level already implies.
 */
function defects(node: unknown, path = ''): string[] {
    if (Array.isArray(node)) {
        return node.flatMap((child, index) => defects(child, `${path}/${index}`));
    }

    if (!isRecord(node)) {
        return [];
    }

    const found = Object.entries(node).flatMap(([key, child]) => defects(child, `${path}/${key}`));
    const bare = existence(node['$hasnt'] ?? []).flatMap(([relation, document]) =>
        isRecord(document) && Object.keys(document).length === 0 ? [relation] : [],
    );

    for (const key of ['$and', '$or']) {
        if (Array.isArray(node[key]) && node[key].length === 0) {
            found.push(`${path}/${key} is empty`);
        }
    }

    for (const document of (node['$and'] ?? []) as FilterTree[]) {
        const refused = existence(document['$hasnt'] ?? []).map(([relation]) => relation);

        if (Object.keys(document).length === 1 && refused.length > 0 && refused.every(r => bare.includes(r))) {
            found.push(`${path}/$and holds a document the bare $hasnt implies`);
        }
    }

    return found;
}

/**
 * Determine whether every object node of a tree is frozen.
 */
function isFrozenThroughout(node: unknown): boolean {
    return (
        typeof node !== 'object' ||
        node === null ||
        (Object.isFrozen(node) && Object.values(node).every(isFrozenThroughout))
    );
}

/** A fixed pool of generated rows with relations nested three levels deep. */
const ROWS: readonly Row[] = (() => {
    const rng = new Random(7);

    return Array.from({ length: 96 }, () => generateRow(rng));
})();

/**
 * Assert the emitted tree of `operations` selects exactly the rows the
 * reference evaluator selects and is structurally sound.
 */
function check(operations: readonly Operation[], label: string): void {
    const tree = build(ApiQuery.create(), operations).filterTree();
    const emitted = ROWS.map(row => matches(tree, row));
    const expected = ROWS.map(row => holdsAll(operations, row));
    const differing = ROWS.filter((_row, index) => emitted[index] !== expected[index]);
    const context = `${label}\noperations: ${JSON.stringify(operations)}\ntree: ${JSON.stringify(tree)}`;

    expect(differing, `${context}\ndiffering rows: ${JSON.stringify(differing.slice(0, 3))}`).toStrictEqual([]);
    expect(defects(tree), context).toStrictEqual([]);
    expect(isFrozenThroughout(tree), context).toBe(true);
}

/**
 * Build an equality on `kind`.
 */
function kind(value: Operand): Operation {
    return { call: 'where', column: 'kind', operator: null, value };
}

/**
 * Build a `$ge` condition on `rank`.
 */
function rankAtLeast(value: Operand): Operation {
    return { call: 'where', column: 'rank', operator: '$ge', value };
}

/**
 * Build a relation call on `parent`.
 */
function onParent(call: 'whereRelation' | 'whereHas' | 'whereHasNot', body: readonly Operation[] | null): Operation {
    return { call, relation: 'parent', body };
}

/**
 * Build a logical group call.
 */
function group(call: 'andWhere' | 'orWhere', ...documents: ReadonlyArray<readonly Operation[]>): Operation {
    return { call, documents };
}

describe('ApiQuery filter semantics', () => {
    it.each<[string, readonly Operation[]]>([
        ['two root groups', [group('orWhere', [kind(0)], [kind(1)]), group('orWhere', [kind(1)], [kind(2)])]],
        ['a colliding equality', [kind(1), kind(2)]],
        ['colliding relation conditions', [onParent('whereHas', [kind(1)]), onParent('whereHas', [kind(2)])]],
        ['a colliding operator', [rankAtLeast(1), rankAtLeast(2)]],
        ['a repeated condition', [kind(1), kind(1)]],
        ['bare then conditioned $hasnt', [onParent('whereHasNot', null), onParent('whereHasNot', [kind(1)])]],
        ['conditioned then bare $hasnt', [onParent('whereHasNot', [kind(1)]), onParent('whereHasNot', null)]],
        [
            'bare $hasnt then a conditioned one in a group',
            [onParent('whereHasNot', null), group('andWhere', [onParent('whereHasNot', [kind(1)])])],
        ],
        [
            'a conditioned $hasnt in a group then a bare one',
            [group('andWhere', [onParent('whereHasNot', [kind(1)])]), onParent('whereHasNot', null)],
        ],
        ['two conditioned $hasnt', [onParent('whereHasNot', [kind(1)]), onParent('whereHasNot', [rankAtLeast(1)])]],
        ['colliding conditions inside a $hasnt', [onParent('whereHasNot', [kind(1), kind(2), rankAtLeast(0)])]],
        [
            'colliding conditions inside a group branch',
            [group('orWhere', [kind(1), kind(2)], [rankAtLeast(1), rankAtLeast(2)])],
        ],
        [
            'colliding conditions inside an $and document',
            [group('andWhere', [kind(0), kind(1), onParent('whereRelation', [])])],
        ],
    ])('selects the described rows for %s', (label, operations) => {
        check(operations, label);
    });

    it.each([11, 23, 37, 41, 53, 67])('selects the described rows for generated sequences from seed %i', seed => {
        const rng = new Random(seed);

        for (let index = 0; index < 50; index += 1) {
            check(generateOperations(rng, 0, 1, 6), `seed ${seed}, sequence ${index}`);
        }
    });
});
