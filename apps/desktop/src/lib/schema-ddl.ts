// The DDL behind each edit made in the diagram, per engine. Edits are staged as data and only
// turned into SQL when shown for review and run, so the same change reads the same everywhere.
import type { Connection } from '@/stores/connections';
import { literal, quoteName } from './sql-quote';

type Kind = Connection['kind'];

export type NewColumn = {
    name: string;
    type: string;
    nullable: boolean;
    /** A SQL expression, written as typed: `now()`, `0`, `'new'` */
    default: string;
    primary: boolean;
};

export type SchemaChange =
    | { op: 'createTable'; table: string; columns: NewColumn[] }
    | { op: 'dropTable'; table: string }
    | { op: 'renameTable'; table: string; to: string }
    | { op: 'addColumn'; table: string; column: NewColumn }
    | { op: 'renameColumn'; table: string; column: string; to: string }
    | { op: 'dropColumn'; table: string; column: string }
    | { op: 'addForeignKey'; table: string; column: string; refTable: string; refColumn: string; name: string }
    | { op: 'dropForeignKey'; table: string; column: string; name: string }
    | { op: 'createIndex'; table: string; name: string; columns: string[]; unique: boolean }
    | { op: 'dropIndex'; table: string; name: string };

/** A staged change; the id lets the review list take one back out */
export type Staged = SchemaChange & { id: string };

/** Common types to suggest while typing a column's type; any type the database accepts works */
export const columnTypes: Record<Kind, string[]> = {
    postgres: ['integer', 'bigint', 'serial', 'text', 'varchar(255)', 'boolean', 'numeric(12,2)', 'timestamptz', 'date', 'uuid', 'jsonb'],
    mysql: ['int', 'bigint', 'varchar(255)', 'text', 'tinyint(1)', 'decimal(12,2)', 'datetime', 'date', 'json'],
    mssql: ['int', 'bigint', 'nvarchar(255)', 'nvarchar(max)', 'bit', 'decimal(12,2)', 'datetime2', 'date', 'uniqueidentifier'],
    sqlite: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB'],
};

/** SQLite can’t add a foreign key to a table that exists (that takes rebuilding it), and its keys have no names to drop them by */
export const supportsForeignKeyDdl = (kind: Kind) => kind !== 'sqlite';

const qualified = (kind: Kind, schema: string, table: string) => `${quoteName(kind, schema)}.${quoteName(kind, table)}`;

function columnDef(kind: Kind, c: NewColumn) {
    const parts = [quoteName(kind, c.name), c.type.trim()];
    if (!c.nullable || c.primary) parts.push('NOT NULL');
    if (c.default.trim()) parts.push(`DEFAULT ${c.default.trim()}`);
    return parts.join(' ');
}

/** The statement a change runs as, in `schema` */
export function changeSql(kind: Kind, schema: string, change: SchemaChange): string {
    const q = (name: string) => quoteName(kind, name);
    const on = (table: string) => `ALTER TABLE ${qualified(kind, schema, table)}`;
    switch (change.op) {
        case 'createTable': {
            const keys = change.columns.filter((c) => c.primary).map((c) => q(c.name));
            const lines = change.columns.map((c) => `  ${columnDef(kind, c)}`);
            if (keys.length) lines.push(`  PRIMARY KEY (${keys.join(', ')})`);
            return `CREATE TABLE ${qualified(kind, schema, change.table)} (\n${lines.join(',\n')}\n)`;
        }
        case 'dropTable':
            return `DROP TABLE ${qualified(kind, schema, change.table)}`;
        case 'renameTable':
            if (kind === 'mysql') return `RENAME TABLE ${qualified(kind, schema, change.table)} TO ${qualified(kind, schema, change.to)}`;
            if (kind === 'mssql') return `EXEC sp_rename ${literal(`${q(schema)}.${q(change.table)}`, kind)}, ${literal(change.to, kind)}, 'OBJECT'`;
            return `${on(change.table)} RENAME TO ${q(change.to)}`;
        case 'addColumn':
            return `${on(change.table)} ADD ${kind === 'mssql' ? '' : 'COLUMN '}${columnDef(kind, change.column)}`;
        case 'renameColumn':
            if (kind === 'mssql')
                return `EXEC sp_rename ${literal(`${q(schema)}.${q(change.table)}.${q(change.column)}`, kind)}, ${literal(change.to, kind)}, 'COLUMN'`;
            return `${on(change.table)} RENAME COLUMN ${q(change.column)} TO ${q(change.to)}`;
        case 'dropColumn':
            return `${on(change.table)} DROP COLUMN ${q(change.column)}`;
        case 'addForeignKey':
            return `${on(change.table)} ADD CONSTRAINT ${q(change.name)} FOREIGN KEY (${q(change.column)}) REFERENCES ${qualified(kind, schema, change.refTable)} (${q(change.refColumn)})`;
        case 'dropForeignKey':
            return `${on(change.table)} DROP ${kind === 'mysql' ? 'FOREIGN KEY' : 'CONSTRAINT'} ${q(change.name)}`;
        case 'createIndex': {
            // The index lives in its table's schema: Postgres, MySQL and SQL Server qualify the table, SQLite the index
            const [index, onTable] =
                kind === 'sqlite'
                    ? [`${quoteName(kind, schema)}.${q(change.name)}`, q(change.table)]
                    : [q(change.name), qualified(kind, schema, change.table)];
            return `CREATE ${change.unique ? 'UNIQUE ' : ''}INDEX ${index} ON ${onTable} (${change.columns.map(q).join(', ')})`;
        }
        case 'dropIndex':
            // Postgres and SQLite name an index on its own; MySQL and SQL Server name it through its table
            return kind === 'postgres' || kind === 'sqlite'
                ? `DROP INDEX ${quoteName(kind, schema)}.${q(change.name)}`
                : `DROP INDEX ${q(change.name)} ON ${qualified(kind, schema, change.table)}`;
    }
}

/** One line for the review list: what the change does, without the SQL */
export function describeChange(change: SchemaChange): string {
    switch (change.op) {
        case 'createTable':
            return `Create table ${change.table}`;
        case 'dropTable':
            return `Drop table ${change.table}`;
        case 'renameTable':
            return `Rename table ${change.table} to ${change.to}`;
        case 'addColumn':
            return `Add column ${change.table}.${change.column.name}`;
        case 'renameColumn':
            return `Rename column ${change.table}.${change.column} to ${change.to}`;
        case 'dropColumn':
            return `Drop column ${change.table}.${change.column}`;
        case 'addForeignKey':
            return `Link ${change.table}.${change.column} to ${change.refTable}.${change.refColumn}`;
        case 'dropForeignKey':
            return `Unlink ${change.table}.${change.column}`;
        case 'createIndex':
            return `Add ${change.unique ? 'unique ' : ''}index ${change.name} on ${change.table} (${change.columns.join(', ')})`;
        case 'dropIndex':
            return `Drop index ${change.name} on ${change.table}`;
    }
}

/** Removes data for good: the review asks once more before running these */
export const destroysData = (change: SchemaChange) => change.op === 'dropTable' || change.op === 'dropColumn';

/** A name for a new foreign key, unique enough per column: `orders_user_id_fkey` */
export const foreignKeyName = (table: string, column: string) => `${table}_${column}_fkey`;

/** A primary key column that numbers itself, for a new table's first column */
export const keyType: Record<Kind, string> = {
    postgres: 'bigint GENERATED ALWAYS AS IDENTITY',
    mysql: 'bigint AUTO_INCREMENT',
    mssql: 'bigint IDENTITY(1,1)',
    sqlite: 'INTEGER',
};

/** A name for a new index: `orders_user_id_idx`, `users_email_key` when unique */
export const indexName = (table: string, columns: string[], unique: boolean) =>
    `${table}_${columns.join('_')}_${unique ? 'key' : 'idx'}`.slice(0, 63);
