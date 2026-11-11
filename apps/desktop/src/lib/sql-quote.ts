// Writing names and values into SQL text, the one place each engine's quoting rule lives.
import type { Connection } from '@/stores/connections';

/** An identifier quoted for the engine: MySQL uses backticks, SQL Server brackets, Postgres and SQLite double quotes; doubling escapes the closing mark */
export function quoteName(kind: Connection['kind'], name: string) {
    if (kind === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
    if (kind === 'mssql') return `[${name.replace(/]/g, ']]')}]`;
    return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A value as a SQL string literal; every engine here coerces a quoted literal to the column's type.
 * MySQL also reads a backslash inside one as an escape (unless NO_BACKSLASH_ESCAPES is set), so it's doubled there.
 * SQL Server's N'…' keeps characters outside the database's code page.
 */
export function literal(value: string, kind?: Connection['kind']) {
    const text = kind === 'mysql' ? value.replace(/\\/g, '\\\\') : value;
    return `${kind === 'mssql' ? 'N' : ''}'${text.replace(/'/g, "''")}'`;
}

const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * "'Attendance'", "42", "NULL": a value as SQL reads it. A numeric column's value is left bare when
 * it reads as a number, otherwise quoted. Kept as the text the database sent: Number() would round
 * ids past 2^53 and filter on the wrong row.
 */
export function sqlValue(value: string | null, numeric: boolean, kind?: Connection['kind']) {
    if (value === null) return 'NULL';
    return numeric && NUMBER.test(value.trim()) ? value.trim() : literal(value, kind);
}
