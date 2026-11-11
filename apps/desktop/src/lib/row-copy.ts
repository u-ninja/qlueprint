// Whole rows of the results grid as clipboard text: JSON objects or INSERT statements.
import type { Connection } from '@/stores/connections';
import { quoteName, sqlValue } from './sql-quote';

type Column = { name: string; kind: string };
type Row = (string | null)[];

/** An array of objects keyed by column name; NULL stays null. A repeated name keeps its last value */
export const rowsAsJson = (columns: Column[], rows: Row[]) =>
    JSON.stringify(
        rows.map((row) => Object.fromEntries(columns.map((c, i) => [c.name, row[i]]))),
        null,
        2,
    );

/** One INSERT per row into `table` (already qualified and quoted), one per line */
export function rowsAsInsert(kind: Connection['kind'], table: string, columns: Column[], rows: Row[]) {
    const names = columns.map((c) => quoteName(kind, c.name)).join(', ');
    return rows
        .map((row) => {
            const values = row.map((v, i) => sqlValue(v, columns[i].kind === 'number', kind));
            return `INSERT INTO ${table} (${names}) VALUES (${values.join(', ')});`;
        })
        .join('\n');
}
