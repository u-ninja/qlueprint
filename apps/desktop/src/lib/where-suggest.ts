// What to suggest at the cursor in a table tab's WHERE box: columns, then operators, then values,
// then AND / OR. Reads only the text before the cursor, with a tiny tokenizer, no SQL parser.

/** A picker with `range` picks both ends of a BETWEEN */
import { unquote } from './sql-refs';

export type Suggestion = {
    label: string;
    insert: string;
    detail?: string;
    kind: 'column' | 'operator' | 'value' | 'keyword' | 'picker';
    range?: boolean;
};

/** `date` marks a column whose values can be picked from a calendar (with a time, for date-times) */
export type SuggestColumn = { name: string; typeName: string; numeric: boolean; date?: 'date' | 'datetime' };

type Token = { text: string; type: 'string' | 'name' | 'number' | 'op' | 'punct' };

// Strings ('it''s'), quoted names ("Order", `order`), bare names, numbers, operators, punctuation
const TOKEN = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|[A-Za-z_][\w$]*|\d+(?:\.\d+)?|<>|!=|>=|<=|[=<>]|[(),]/g;

const COMPARE = new Set(['=', '<>', '!=', '>', '<', '>=', '<=', 'LIKE', 'ILIKE']);
const JOINERS = new Set(['AND', 'OR', 'NOT', '(']);

export function operators(postgres: boolean): Suggestion[] {
    const ops: [string, string, string][] = [
        ['=', '= ', 'equals'],
        ['<>', '<> ', 'not equal'],
        ['>', '> ', ''],
        ['<', '< ', ''],
        ['>=', '>= ', ''],
        ['<=', '<= ', ''],
        ['BETWEEN', 'BETWEEN ', 'a range, both ends included'],
        ['LIKE', 'LIKE ', 'pattern, % = any text'],
        ...(postgres ? [['ILIKE', 'ILIKE ', 'pattern, ignoring case'] as [string, string, string]] : []),
        ['IN (…)', 'IN (', 'one of a list'],
        ['IS NULL', 'IS NULL ', ''],
        ['IS NOT NULL', 'IS NOT NULL ', ''],
    ];
    return ops.map(([label, insert, detail]) => ({ label, insert, detail, kind: 'operator' }));
}

const keywords = (...words: string[]): Suggestion[] => words.map((w) => ({ label: w, insert: `${w} `, kind: 'keyword' }));

/** Items ranked by the word typed so far: prefix matches first, then anywhere in the label */
function rank(items: Suggestion[], word: string) {
    const w = word.toLowerCase().replace(/^['"`]/, '');
    if (!w) return items;
    const starts = items.filter((i) => unquote(i.label).toLowerCase().startsWith(w));
    const contains = items.filter((i) => !starts.includes(i) && i.label.toLowerCase().includes(w));
    return [...starts, ...contains];
}

/**
 * `from` is where the replaced word starts; inserting replaces text.slice(from, caret).
 * `quote` turns a column name into what to type (quoted when the engine needs it);
 * `values` gives sample values for a column, already as SQL literals.
 */
export function suggestWhere(
    text: string,
    caret: number,
    columns: SuggestColumn[],
    opts: { postgres: boolean; quote: (name: string) => string; values: (column: string) => string[] },
): { from: number; items: Suggestion[] } {
    const before = text.slice(0, caret);
    // The word being typed: an unclosed string, a quoted name being typed, or a bare word
    // (an odd number of a quote character means one is still open)
    const openQuote = ["'", '"', '`'].find((q) => before.split(q).length % 2 === 0);
    const word = (openQuote ? before.slice(before.lastIndexOf(openQuote)) : /[\w$]*$/.exec(before)?.[0]) ?? '';
    const from = caret - word.length;
    const tokens: Token[] = [...before.slice(0, from).matchAll(TOKEN)].map(([t]) => ({
        text: t,
        type: t.startsWith("'") ? 'string' : /^["`A-Za-z_]/.test(t) ? 'name' : /^\d/.test(t) ? 'number' : /^[(),]$/.test(t) ? 'punct' : 'op',
    }));
    const upper = (t?: Token) => t?.text.toUpperCase() ?? '';
    const prev = tokens[tokens.length - 1];
    const columnNamed = (t?: Token) => (t?.type === 'name' ? columns.find((c) => c.name.toLowerCase() === unquote(t.text).toLowerCase()) : undefined);

    const columnItems = (): Suggestion[] =>
        columns.map((c) => ({ label: c.name, insert: `${opts.quote(c.name)} `, detail: c.typeName, kind: 'column' }));
    const valueItems = (column: SuggestColumn | undefined, after = ' '): Suggestion[] =>
        column ? opts.values(column.name).map((v) => ({ label: v, insert: `${v}${after}`, detail: column.name, kind: 'value' })) : [];

    // Inside IN ( … ): values of the column before IN, separated by commas
    const open = tokens.map((t) => t.text).lastIndexOf('(');
    const inList = open > 0 && upper(tokens[open - 1]) === 'IN' && !tokens.slice(open).some((t) => t.text === ')');
    if (inList && (prev?.text === '(' || prev?.text === ',')) {
        return { from, items: rank(valueItems(columnNamed(tokens[open - 2]), ''), word) };
    }

    const back = (n: number) => upper(tokens[tokens.length - n]);
    /** Values of a column, its calendar first when it's a date column: picking beats typing a timestamp */
    const valuesFor = (column: SuggestColumn | undefined, range = false) => {
        const label = range
            ? column?.date === 'datetime'
                ? 'Pick a date and time range…'
                : 'Pick a date range…'
            : column?.date === 'datetime'
              ? 'Pick date and time…'
              : 'Pick a date…';
        const picker: Suggestion[] = column?.date ? [{ label, insert: '', detail: column.name, kind: 'picker', range }] : [];
        return { from, items: [...picker, ...rank(valueItems(column), word)] };
    };

    // col BETWEEN ▮ x AND y: the first end, or both from a range calendar
    if (back(1) === 'BETWEEN') return valuesFor(columnNamed(tokens[tokens.length - 2]), true);
    // col BETWEEN x ▮: only AND continues it
    if (back(2) === 'BETWEEN') return { from, items: rank(keywords('AND'), word) };
    // col BETWEEN x AND ▮: the second end, not a new condition
    if (back(1) === 'AND' && back(3) === 'BETWEEN') return valuesFor(columnNamed(tokens[tokens.length - 4]));

    let items: Suggestion[];
    if (!prev || JOINERS.has(upper(prev))) items = columnItems();
    else if (upper(prev) === 'IS') items = keywords('NULL', 'NOT NULL');
    else if (upper(prev) === 'NOT' && upper(tokens[tokens.length - 2]) === 'IS') items = keywords('NULL');
    else if (COMPARE.has(upper(prev))) return valuesFor(columnNamed(tokens[tokens.length - 2]));
    else if (columnNamed(prev) && !COMPARE.has(back(2)) && back(2) !== 'BETWEEN') items = operators(opts.postgres);
    // After a complete condition: join the next one
    else items = keywords('AND', 'OR');
    return { from, items: rank(items, word) };
}
