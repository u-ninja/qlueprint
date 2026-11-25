// Some of a schema's tables as a graph: their columns, and the foreign keys between them. What the
// database reports is loaded once; staged edits are laid over it, so the diagram shows the result
// of a change before it runs.
import dagre from '@dagrejs/dagre';
import type { TableDetails } from '@/bindings';
import { detailsOf } from './table-details';
import type { NewColumn, SchemaChange } from './schema-ddl';

export type Target = { connectionId: string; database: string; schema: string };

export const targetKey = (t: Target) => JSON.stringify([t.connectionId, t.database, t.schema]);

/** What a staged change did to something that is in the diagram */
export type Mark = 'new' | 'dropped' | 'renamed';

export type GraphColumn = {
    name: string;
    type: string;
    nullable: boolean;
    key: string | null;
    mark?: Mark;
};

export type GraphTable = {
    name: string;
    columns: GraphColumn[];
    mark?: Mark;
    /** Tables connected to this one by a foreign key that the graph doesn't show yet */
    more: string[];
};

export type Relation = {
    /** table.column, which is also what the edge is drawn from */
    table: string;
    column: string;
    refTable: string;
    refColumn: string;
    /** The constraint's name; null when the database doesn't name it (SQLite) */
    name: string | null;
    mark?: Mark;
};

export type Graph = { tables: GraphTable[]; relations: Relation[] };

/** The columns and keys of one table, as the graph draws them */
function tableOf(name: string, details: TableDetails, more: string[]): GraphTable {
    return {
        name,
        more,
        columns: details.columns.map((c) => ({ name: c.name, type: c.typeName, nullable: c.nullable, key: c.key ?? null })),
    };
}

/** Foreign keys that stay inside the schema: a graph shows one schema at a time */
function relationsOf(table: string, schema: string, details: TableDetails): Relation[] {
    return details.columns.flatMap((c) =>
        c.references && c.referencesColumn && (c.referencesSchema ?? schema) === schema
            ? [{ table, column: c.name, refTable: c.references, refColumn: c.referencesColumn, name: c.referenceName ?? null }]
            : [],
    );
}

/** The tables a table points at and the tables pointing at it, in its schema, itself left out */
function connectedTo(table: string, schema: string, details: TableDetails): Set<string> {
    const names = new Set<string>();
    for (const c of details.columns) if (c.references && (c.referencesSchema ?? schema) === schema) names.add(c.references);
    for (const r of details.referencedBy) if (r.schema === schema) names.add(r.table);
    names.delete(table);
    return names;
}

/** A column a staged change adds */
const graphColumn = (c: NewColumn): GraphColumn => ({
    name: c.name,
    type: c.type,
    nullable: c.nullable && !c.primary,
    key: c.primary ? 'PK' : null,
    mark: 'new',
});

const POOL = 6;

/**
 * The tables in `expanded` and every table connected to them, with the foreign keys between those.
 * Each table's details are read once, a few at a time so a big schema doesn't open a hundred catalog
 * reads at once: first the expanded tables, which say who their neighbours are, then the neighbours.
 */
export async function loadGraph(target: Target, expanded: string[], cancelled: () => boolean): Promise<Graph> {
    const details = new Map<string, TableDetails>();
    const read = async (names: string[]) => {
        const todo = names.filter((n) => !details.has(n));
        let next = 0;
        const worker = async () => {
            while (next < todo.length && !cancelled()) {
                const name = todo[next++];
                details.set(name, await detailsOf({ ...target, table: name }));
            }
        };
        await Promise.all(Array.from({ length: Math.min(POOL, todo.length) }, worker));
        // Superseded while reading: the caller has moved on, and some tables were never read
        if (cancelled()) throw new Error('Cancelled');
    };
    await read(expanded);
    const shown = new Set(expanded);
    for (const name of expanded) for (const other of connectedTo(name, target.schema, details.get(name)!)) shown.add(other);
    await read([...shown]);
    const names = [...shown];
    return {
        tables: names.map((name) => {
            const d = details.get(name)!;
            return tableOf(
                name,
                d,
                [...connectedTo(name, target.schema, d)].filter((n) => !shown.has(n)),
            );
        }),
        relations: names.flatMap((name) => relationsOf(name, target.schema, details.get(name)!)).filter((r) => shown.has(r.refTable)),
    };
}

/** The graph with `changes` applied, in the order they were staged; the original isn't touched */
export function withChanges(graph: Graph, changes: SchemaChange[]): Graph {
    const out = structuredClone(graph);
    const table = (name: string) => out.tables.find((t) => t.name === name);
    const column = (t: string, c: string) => table(t)?.columns.find((x) => x.name === c);
    const relations = (pick: (r: Relation) => boolean) => out.relations.filter(pick);
    for (const change of changes) {
        switch (change.op) {
            case 'createTable':
                out.tables.push({
                    name: change.table,
                    mark: 'new',
                    more: [],
                    columns: change.columns.map(graphColumn),
                });
                break;
            case 'dropTable': {
                const t = table(change.table);
                if (t) t.mark = 'dropped';
                for (const r of relations((r) => r.table === change.table || r.refTable === change.table)) r.mark = 'dropped';
                break;
            }
            case 'renameTable': {
                const t = table(change.table);
                if (t) Object.assign(t, { name: change.to, mark: t.mark === 'new' ? 'new' : 'renamed' });
                for (const r of out.relations) {
                    if (r.table === change.table) r.table = change.to;
                    if (r.refTable === change.table) r.refTable = change.to;
                }
                break;
            }
            case 'addColumn':
                table(change.table)?.columns.push(graphColumn(change.column));
                break;
            case 'renameColumn': {
                const c = column(change.table, change.column);
                if (c) Object.assign(c, { name: change.to, mark: c.mark === 'new' ? 'new' : 'renamed' });
                for (const r of out.relations) {
                    if (r.table === change.table && r.column === change.column) r.column = change.to;
                    if (r.refTable === change.table && r.refColumn === change.column) r.refColumn = change.to;
                }
                break;
            }
            case 'dropColumn': {
                const c = column(change.table, change.column);
                if (c) c.mark = 'dropped';
                for (const r of relations(
                    (r) => (r.table === change.table && r.column === change.column) || (r.refTable === change.table && r.refColumn === change.column),
                ))
                    r.mark = 'dropped';
                break;
            }
            case 'addForeignKey': {
                out.relations.push({
                    table: change.table,
                    column: change.column,
                    refTable: change.refTable,
                    refColumn: change.refColumn,
                    name: change.name,
                    mark: 'new',
                });
                const c = column(change.table, change.column);
                if (c && !c.key) c.key = 'FK';
                break;
            }
            case 'dropForeignKey':
                // A composite key is one constraint over several columns: dropping it drops every edge it draws
                for (const r of relations((r) => r.table === change.table && r.name === change.name)) r.mark = 'dropped';
                break;
        }
    }
    return out;
}

// The size a table node is laid out at; TableNode sizes its rows from the same numbers
export const NODE_WIDTH = 248;
export const HEADER = 34;
export const ROW = 26;
export const FOOTER = 30;
export const nodeHeight = (columns: number) => HEADER + columns * ROW + FOOTER;

export type Positions = Record<string, { x: number; y: number }>;

/** Left to right, referenced tables before the ones that point at them */
export function layout(graph: Graph): Positions {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 90, marginx: 24, marginy: 24 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const t of graph.tables) g.setNode(t.name, { width: NODE_WIDTH, height: nodeHeight(t.columns.length) });
    for (const r of graph.relations) if (r.table !== r.refTable && g.hasNode(r.table) && g.hasNode(r.refTable)) g.setEdge(r.refTable, r.table);
    dagre.layout(g);
    return Object.fromEntries(
        graph.tables.map((t) => {
            const n = g.node(t.name);
            return [t.name, { x: n.x - NODE_WIDTH / 2, y: n.y - nodeHeight(t.columns.length) / 2 }];
        }),
    );
}
