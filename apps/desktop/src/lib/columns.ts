import { commands, type ColumnInfo } from '@/bindings';
import type { Connection } from '@/stores/connections';
import { quoteName } from './sql-quote';

// Columns for autocomplete, per open connection and database: fetched once on first use, then kept
// until the connection is refreshed or closed. A Promise, so concurrent asks share one fetch
const cache = new Map<string, Promise<ColumnInfo[]>>();

const keyOf = (connectionId: string, database: string) => JSON.stringify([connectionId, database]);

export function columnsOf(connectionId: string, database: string): Promise<ColumnInfo[]> {
    const key = keyOf(connectionId, database);
    let columns = cache.get(key);
    if (!columns) {
        // A failure isn't kept: the next keystroke tries again
        columns = commands.listColumns(connectionId, database || null).catch((error) => {
            cache.delete(key);
            throw error;
        });
        cache.set(key, columns);
    }
    return columns;
}

/** After a refresh (tables may have changed) or a disconnect */
export function forgetColumns(connectionId: string) {
    for (const key of cache.keys()) if ((JSON.parse(key) as string[])[0] === connectionId) cache.delete(key);
}

/**
 * A name as it can be typed into SQL: bare when the engine would read it back unchanged, quoted
 * otherwise. Postgres folds bare names to lowercase, so `AirTicketTrip` needs quotes there; MySQL,
 * SQLite and SQL Server (with its usual case-insensitive collation) keep them, so only odd characters need them.
 */
export function sqlName(kind: Connection['kind'], name: string) {
    const bare = kind === 'postgres' ? /^[a-z_][a-z0-9_$]*$/ : /^[A-Za-z_][A-Za-z0-9_$]*$/;
    if (bare.test(name) && !reserved.has(name.toLowerCase())) return name;
    return quoteName(kind, name);
}

// Names that would read as keywords if left bare; not exhaustive, just the ones tables and columns commonly use
const reserved = new Set([
    'order',
    'group',
    'user',
    'select',
    'from',
    'where',
    'table',
    'index',
    'key',
    'limit',
    'desc',
    'asc',
    'check',
    'default',
    'column',
    'to',
    'by',
    'and',
    'or',
    'not',
    'null',
    'end',
]);

/** Where unqualified names resolve: Postgres' usual search_path, MySQL's current database, SQL Server's dbo, SQLite's main */
export function homeSchema(kind: Connection['kind'], database: string) {
    if (kind === 'postgres') return 'public';
    if (kind === 'mysql') return database;
    return kind === 'mssql' ? 'dbo' : 'main';
}

/**
 * Columns grouped schema → table → columns, with a case-insensitive index for lookups. Built once per
 * fetched list (the cache hands out the same array until a refresh), not on every keystroke.
 */
export type Catalog = {
    tables: Map<string, Map<string, ColumnInfo[]>>;
    /** lowercased schema → lowercased table → the table's own spelling, and the schema's */
    index: Map<string, { schema: string; tables: Map<string, string> }>;
};
const catalogs = new WeakMap<ColumnInfo[], Catalog>();
export function catalogOf(columns: ColumnInfo[]): Catalog {
    let catalog = catalogs.get(columns);
    if (!catalog) {
        catalog = { tables: new Map(), index: new Map() };
        for (const c of columns) {
            const schema = catalog.tables.get(c.schema) ?? catalog.tables.set(c.schema, new Map()).get(c.schema)!;
            (schema.get(c.table) ?? schema.set(c.table, []).get(c.table)!).push(c);
            const entry =
                catalog.index.get(c.schema.toLowerCase()) ??
                catalog.index.set(c.schema.toLowerCase(), { schema: c.schema, tables: new Map() }).get(c.schema.toLowerCase())!;
            entry.tables.set(c.table.toLowerCase(), c.table);
        }
        catalogs.set(columns, catalog);
    }
    return catalog;
}

/** A table by name, ignoring case: in the given schema, else `home`, else any schema */
export function findTable(catalog: Catalog, table: string, home: string, schema?: string) {
    const name = table.toLowerCase();
    const look = (s: string) => {
        const entry = catalog.index.get(s.toLowerCase());
        const match = entry?.tables.get(name);
        return entry && match ? { schema: entry.schema, table: match } : undefined;
    };
    if (schema) return look(schema);
    return look(home) ?? [...catalog.index.values()].map((e) => look(e.schema)).find(Boolean);
}
