// Checks that help while writing SQL, kept free of Monaco so they can be tested on their own:
// splitting a script into statements, the warnings worth an underline, and readable parser errors.

type Statement = { text: string; start: number };

/**
 * The statements of a script and where each starts, split on `;` (and SQL Server's GO lines) outside
 * strings, quoted names, comments and Postgres $$ blocks. Empty ones (only whitespace or comments) are left out.
 */
export function splitStatements(sql: string): Statement[] {
    const out: Statement[] = [];
    let start = 0;
    let i = 0;
    const push = (end: number) => {
        const text = sql.slice(start, end);
        // Report where the statement's own text begins, after leading blank lines
        const lead = text.length - text.trimStart().length;
        if (text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) out.push({ text: text.trim(), start: start + lead });
    };
    while (i < sql.length) {
        const c = sql[i];
        const two = sql.slice(i, i + 2);
        if (c === "'" || c === '"' || c === '`' || c === '[') {
            // A doubled quote inside is an escaped one, so skipping to the next quote and on works ([name]]s] too)
            const end = sql.indexOf(c === '[' ? ']' : c, i + 1);
            i = end < 0 ? sql.length : end + 1;
        } else if (two === '--') {
            const end = sql.indexOf('\n', i);
            i = end < 0 ? sql.length : end + 1;
        } else if (two === '/*') {
            const end = sql.indexOf('*/', i + 2);
            i = end < 0 ? sql.length : end + 2;
        } else if (c === '$') {
            // $$ … $$ or $tag$ … $tag$ (Postgres function bodies); a lone $1 parameter is just a character
            const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
            if (tag) {
                const end = sql.indexOf(tag, i + tag.length);
                i = end < 0 ? sql.length : end + tag.length;
            } else i++;
        } else if (c === ';') {
            push(i);
            start = ++i;
        } else if ((i === 0 || sql[i - 1] === '\n') && /^[ \t]*go[ \t]*(\r?\n|$)/i.test(sql.slice(i, i + 80))) {
            // SQL Server's batch separator: a line that is just GO
            push(i);
            const end = sql.indexOf('\n', i);
            start = i = end < 0 ? sql.length : end + 1;
        } else i++;
    }
    push(sql.length);
    return out;
}

/** The statement's first keyword, upper case, ignoring leading comments and brackets */
export function firstKeyword(statement: string) {
    return /^[\s(]*([A-Za-z]+)/.exec(statement.replace(/^(\s*(--[^\n]*\n?|\/\*[\s\S]*?\*\/))*/, ''))?.[1]?.toUpperCase() ?? '';
}

/** Statements the parser understands well enough that its "error" is worth an underline */
export const CHECKED = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE']);

export type Finding = { start: number; end: number; message: string; severity: 'error' | 'warning'; fix?: { title: string; text: string } };

/** UPDATE or DELETE with no WHERE changes every row: almost always a mistake worth a second look */
export function unguardedWrite(statement: Statement): Finding | undefined {
    const kw = firstKeyword(statement.text);
    if (kw !== 'UPDATE' && kw !== 'DELETE') return undefined;
    // Strings and comments can't hide a WHERE from this check, nor fake one
    const code = statement.text.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
    if (/\bWHERE\b/i.test(code)) return undefined;
    const at = statement.text.toUpperCase().indexOf(kw);
    return {
        start: statement.start + at,
        end: statement.start + at + kw.length,
        severity: 'warning',
        message: `${kw} without WHERE changes every row in the table.`,
    };
}

/** Edit distance, for "Did you mean": small names only, so the quadratic table is tiny */
function distance(a: string, b: string) {
    a = a.toLowerCase();
    b = b.toLowerCase();
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = row;
    }
    return prev[b.length];
}

/** The known name closest to a mistyped one, if it's close enough to be what was meant */
export function closest(name: string, known: Iterable<string>) {
    let best: string | undefined;
    let bestScore = Math.max(2, Math.floor(name.length / 3)) + 1;
    for (const k of known) {
        // The distance is at least the length difference, so such a name can't do better
        if (Math.abs(k.length - name.length) >= bestScore) continue;
        const d = distance(name, k);
        if (d < bestScore) [best, bestScore] = [k, d];
    }
    return best;
}

/** `Expected "#", "--", … but "*" found.` → `unexpected “*”`: the parser's list of alternatives helps no one */
export function readableParseError(message: string) {
    const found = /but (?:"((?:[^"\\]|\\.)*)"|(end of input)) found/.exec(message);
    if (!found) return 'Syntax error';
    if (found[2]) return 'Syntax error: the statement ends too early';
    const token = found[1].replace(/\\(.)/g, '$1');
    return token.trim() ? `Syntax error near “${token}”` : 'Syntax error near this space';
}

// Statements the database has run without complaint: never underlined, whatever the parser thinks of
// them. The database is the authority; the parser's grammar is only an approximation of it.
// shortcut: grows with every distinct statement run this session; cap it if sessions run for weeks
const accepted = new Set<string>();
const key = (statement: string) => statement.replace(/\s+/g, ' ').trim();
export const markAccepted = (sql: string) => splitStatements(sql).forEach((s) => accepted.add(key(s.text)));
export const isAccepted = (statement: string) => accepted.has(key(statement));
