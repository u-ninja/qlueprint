// A filter on one column, built from the grid's menus: turned into SQL for a table tab (the database
// filters the whole table) or applied to the loaded rows of a query result.

import type { Connection } from '@/stores/connections';
import { literal, sqlValue } from './sql-quote';

export type FilterKind = 'text' | 'number' | 'date' | 'datetime';

export type FilterOp = '=' | '<>' | '>' | '<' | '>=' | '<=' | 'contains' | 'starts' | 'between' | 'null' | 'not null';

export type ColumnFilter = { column: string; kind: FilterKind; op: FilterOp; value?: string; value2?: string };

const dateOps: [FilterOp, string][] = [
    ['=', 'on'],
    ['<', 'before'],
    ['>', 'after'],
    ['between', 'between'],
    ['null', 'is NULL'],
    ['not null', 'is not NULL'],
];

/** The operators offered for a kind of column, with their labels; dates read as on / before / after */
export const opsFor: Record<FilterKind, [FilterOp, string][]> = {
    text: [
        ['=', 'equals'],
        ['<>', 'is not'],
        ['contains', 'contains'],
        ['starts', 'starts with'],
        ['null', 'is NULL'],
        ['not null', 'is not NULL'],
    ],
    number: [
        ['=', '='],
        ['<>', '≠'],
        ['>', '>'],
        ['>=', '≥'],
        ['<', '<'],
        ['<=', '≤'],
        ['between', 'between'],
        ['null', 'is NULL'],
        ['not null', 'is not NULL'],
    ],
    date: dateOps,
    // Same words; before, after and between also take a time of day
    datetime: dateOps,
};

/** How a column filters, from the type the database reported: DATE gets a calendar, DATETIME and
 * TIMESTAMP a calendar and a time, TIME alone filters as text */
export function filterKindOf(kind: string, typeName: string): FilterKind {
    if (kind === 'number') return 'number';
    if (kind !== 'temporal') return 'text';
    const type = typeName.toLowerCase();
    if (/datetime|timestamp/.test(type)) return 'datetime';
    return /^time/.test(type) ? 'text' : 'date';
}

/** A date-time cell as `YYYY-MM-DD HH:MM:SS`: drivers print a T, fractions or a zone after it */
const asDateTime = (cell: string) => cell.replace('T', ' ').slice(0, 19);

/** How many values an operator takes */
export const arity = (op: FilterOp) => (op === 'null' || op === 'not null' ? 0 : op === 'between' ? 2 : 1);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day after a YYYY-MM-DD, as YYYY-MM-DD: "on" and "between" include the whole last day */
function nextDay(day: string) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

const label = (f: ColumnFilter) => opsFor[f.kind].find(([op]) => op === f.op)?.[1] ?? f.op;

/** "created_at between 2026-01-01 and 2026-01-31", for chips and titles */
export function describeFilter(f: ColumnFilter) {
    const n = arity(f.op);
    return `${f.column} ${label(f)}${n ? ` ${f.value ?? ''}` : ''}${n === 2 ? ` and ${f.value2 ?? ''}` : ''}`;
}

/**
 * The filter as a SQL condition. `name` is the column, already quoted for the engine. Dates compare as ranges of whole days, so they work on DATE, DATETIME and TIMESTAMP columns
 * alike and use an index on the column.
 */
export function filterSql(f: ColumnFilter, name: string, kind: Connection['kind']) {
    const lit = (v: string) => literal(v, kind);
    const a = f.value ?? '';
    const b = f.value2 ?? '';
    const v = (x: string) => sqlValue(x, f.kind === 'number', kind);
    if (f.op === 'null') return `${name} IS NULL`;
    if (f.op === 'not null') return `${name} IS NOT NULL`;
    const dated = f.kind === 'date' || f.kind === 'datetime';
    if (dated && DAY.test(a)) {
        if (f.op === '=') return `${name} >= ${lit(a)} AND ${name} < ${lit(nextDay(a))}`;
        if (f.op === '>') return `${name} >= ${lit(nextDay(a))}`;
        if (f.op === 'between' && DAY.test(b)) return `${name} >= ${lit(a)} AND ${name} < ${lit(nextDay(b))}`;
    }
    // A date-time with its time of day: compared as given; "between" includes both ends
    if (dated && f.op === 'between') return `${name} >= ${lit(a)} AND ${name} <= ${lit(b)}`;
    if (dated) return `${name} ${f.op} ${lit(a)}`;
    // Text match: Postgres needs the cast for non-text columns and ILIKE to ignore case; MySQL's and SQLite's LIKE already do.
    // shortcut: % and _ typed in the value act as wildcards, escape them if people filter on literal percent signs
    const text = kind === 'postgres' ? `${name}::text ILIKE` : `${name} LIKE`;
    if (f.op === 'contains') return `${text} ${lit(`%${a}%`)}`;
    if (f.op === 'starts') return `${text} ${lit(`${a}%`)}`;
    if (f.op === 'between') return `${name} BETWEEN ${v(a)} AND ${v(b)}`;
    return `${name} ${f.op} ${v(a)}`;
}

/** Whether a loaded cell passes the filter: the same meaning as filterSql, on the strings the grid holds */
export function filterMatches(f: ColumnFilter, cell: string | null) {
    if (f.op === 'null') return cell === null;
    if (f.op === 'not null') return cell !== null;
    if (cell === null) return false;
    const a = f.value ?? '';
    const b = f.value2 ?? '';
    if (f.op === 'contains') return cell.toLowerCase().includes(a.toLowerCase());
    if (f.op === 'starts') return cell.toLowerCase().startsWith(a.toLowerCase());

    // Dates compare as YYYY-MM-DD days (or to the second, when the filter has a time); numbers as numbers; text as text
    const byDay = f.kind === 'date' || (f.kind === 'datetime' && DAY.test(a));
    const value: string | number = byDay ? cell.slice(0, 10) : f.kind === 'datetime' ? asDateTime(cell) : f.kind === 'number' ? Number(cell) : cell;
    const to = (x: string) => (f.kind === 'number' ? Number(x) : x);
    switch (f.op) {
        case '=':
            return value === to(a);
        case '<>':
            return value !== to(a);
        case '>':
            return value > to(a);
        case '>=':
            return value >= to(a);
        case '<':
            return value < to(a);
        case '<=':
            return value <= to(a);
        case 'between':
            return value >= to(a) && value <= to(b);
    }
}

/** The rows passing every filter; `names` are the result's column names, in order */
export function filterRows(rows: (string | null)[][], names: string[], filters: ColumnFilter[]) {
    const checks = filters.map((f) => ({ f, index: names.indexOf(f.column) })).filter((c) => c.index >= 0);
    return checks.length ? rows.filter((row) => checks.every(({ f, index }) => filterMatches(f, row[index]))) : rows;
}
