// Range math, fill series and TSV for the results grid's Excel-style editing. Self-contained, no imports.

/** A rectangle of cells, inclusive on both ends */
export type Rect = { r0: number; r1: number; c0: number; c1: number };

export const sameRect = (a: Rect | null, b: Rect | null) =>
    a === b || (!!a && !!b && a.r0 === b.r0 && a.r1 === b.r1 && a.c0 === b.c0 && a.c1 === b.c1);

/**
 * What dragging the fill handle from `sel` to cell (r, c) covers: the selection grown along the axis
 * the pointer moved further on, like Excel. Null while still inside the selection
 */
export function fillTarget(sel: Rect, r: number, c: number): Rect | null {
    const dr = r > sel.r1 ? r - sel.r1 : r < sel.r0 ? r - sel.r0 : 0;
    const dc = c > sel.c1 ? c - sel.c1 : c < sel.c0 ? c - sel.c0 : 0;
    if (!dr && !dc) return null;
    if (Math.abs(dr) >= Math.abs(dc)) return dr > 0 ? { ...sel, r1: r } : { ...sel, r0: r };
    return dc > 0 ? { ...sel, c1: c } : { ...sel, c0: c };
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** The next values of an arithmetic series (1, 2 → 3; 10, 20 → 30), or undefined when `source` isn't one */
function series(source: (string | null)[]) {
    // Past 15 digits Number() rounds, and a big id would continue from the wrong value
    if (source.length < 2 || !source.every((v) => v !== null && DECIMAL.test(v) && v.replace(/[-.]/g, '').length <= 15)) return undefined;
    const text = source as string[];
    const nums = text.map(Number);
    const step = nums[1] - nums[0];
    const decimals = Math.max(...text.map((v) => v.split('.')[1]?.length ?? 0));
    const slack = 10 ** -decimals / 2;
    if (!nums.every((n, i) => i === 0 || Math.abs(n - nums[i - 1] - step) < slack)) return undefined;
    const last = nums[nums.length - 1];
    return (k: number) => (last + step * (k + 1)).toFixed(decimals);
}

/**
 * Values for `count` cells beyond `source`, which is ordered toward the fill direction (reverse it to
 * fill up or left). A numeric run continues as a series; anything else repeats as a block
 */
export function fillValues(source: (string | null)[], count: number, numeric: boolean): (string | null)[] {
    const next = numeric ? series(source) : undefined;
    return Array.from({ length: count }, (_, k) => (next ? next(k) : source[k % source.length]));
}

// Quoted only when it has to be, so a pasted plain value isn't wrapped in quotes elsewhere
const quote = (v: string) => (/[\t\n\r]/.test(v) || v.startsWith('"') ? `"${v.replace(/"/g, '""')}"` : v);

/** Rows by newlines, cells by tabs, as spreadsheets copy them; NULL becomes an empty cell */
export const toTsv = (rows: (string | null)[][]) => rows.map((r) => r.map((v) => quote(v ?? '')).join('\t')).join('\n');

/** Parses spreadsheet-style clipboard text; a cell starting with a quote and closed by one may hold tabs and newlines */
export function parseTsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let i = 0;
    const n = text.length;
    for (;;) {
        let cell = '';
        if (text[i] === '"') {
            let j = i + 1;
            let quoted = '';
            let closed = false;
            for (;;) {
                const q = text.indexOf('"', j);
                if (q < 0) break;
                quoted += text.slice(j, q);
                if (text[q + 1] === '"') j = q + 2;
                else {
                    j = q + 1;
                    closed = true;
                    break;
                }
                quoted += '"';
            }
            // An unclosed quote is just text
            if (closed) {
                cell = quoted;
                i = j;
            }
        }
        let k = i;
        while (k < n && text[k] !== '\t' && text[k] !== '\n' && text[k] !== '\r') k++;
        row.push(cell + text.slice(i, k));
        if (k >= n) break;
        if (text[k] === '\t') {
            i = k + 1;
            continue;
        }
        rows.push(row);
        row = [];
        i = k + (text[k] === '\r' && text[k + 1] === '\n' ? 2 : 1);
        // A trailing newline doesn't start another row
        if (i >= n) return rows;
    }
    rows.push(row);
    return rows;
}
