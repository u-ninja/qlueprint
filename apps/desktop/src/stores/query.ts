import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { commands, type QueryOutput, type QueryPlan, type ResultColumn, type ResultSet } from '@/bindings';
import { count } from '@/lib/utils';
import { errorMessage, useConnections, type Connection } from './connections';
import { filterSql, type ColumnFilter } from '@/lib/column-filter';
import { quoteName, sqlValue } from '@/lib/sql-quote';
import { tableKey } from '@/lib/table-details';
import { sourceTable } from '@/lib/columns';
import { rowsAsInsert } from '@/lib/row-copy';
import { markAccepted, splitStatements } from '@/lib/sql-lint';
import { inShownWorkspace, useUi } from './ui';

export type Message = { at: Date; ok: boolean; text: string };

export type Outcome = { ok: true; output: QueryOutput } | { ok: false; error: string };

export type Sort = { column: string; desc: boolean };

/** A query tab's last Explain; the previous outcome stays while a new one is in flight */
export type Plan = {
    runningSince: number | null;
    outcome: { ok: true; plan: QueryPlan } | { ok: false; error: string } | null;
};

/** One row's staged cell edits, or a row staged to be added or removed */
export type RowEdit = {
    /** Primary key column → value as loaded: the UPDATE finds the row by these, so editing the key itself is safe.
     * A new row's is a made-up id under '', never a real key */
    pk: [string, string][];
    /** Changed column → its loaded value and the new one. A new row's columns are all `from: null`; one left out takes its default */
    changes: Record<string, { from: string | null; to: string | null }>;
    op?: 'insert' | 'delete';
};

/** One cell's new value; `from` is its loaded value, and staging that unstages the cell */
export type CellEdit = { pk: RowEdit['pk']; column: string; from: string | null; to: string | null };

/** The rows (`rowKey`) one undo step changed: each one's staged state before and after (undefined: nothing staged) */
type RowStep = { key: string; before: RowEdit | undefined; after: RowEdit | undefined }[];

/** A query sheet: its own draft, its own connection and database, and its own last result */
export type QueryTab = {
    id: string;
    title: string;
    /** What's in the editor now */
    sql: string;
    /** What was last saved; only this survives a restart. sql !== saved means unsaved changes */
    saved: string;
    /** Picked in the toolbar; null (or a connection that's closed) means "the most recently opened connection" */
    connectionId: string | null;
    /** Picked in the toolbar for connectionId; null means the connection's own database */
    database: string | null;
    /** When the current run started, null while idle */
    runningSince: number | null;
    /** Kept while a new run is in flight so the panel can show it as stale instead of blanking */
    last: Outcome | null;
    /** What produced `last`, so "Load all rows" can run it again */
    lastRun: { connectionId: string; database: string; sql: string } | null;
    /** The order the database put `last` in: a cut-off result is sorted by running it again */
    serverSort: Sort | null;
    /** Separate from `last`: explaining doesn't replace the results */
    plan: Plan | null;
};

/** A table opened from the explorer: its own tab with just its rows, no editor */
export type TableTab = {
    /** connection, database, schema and table, so opening the same table again finds this tab */
    id: string;
    connectionId: string;
    database: string;
    schema: string;
    table: string;
    /** A SQL condition the database applies; '' for none */
    where: string;
    /** Column filters from the grid's menus, ANDed with `where`; at most one per column */
    filters: ColumnFilter[];
    /** Ordered by the database, so it holds for the whole table, not just the loaded rows */
    sort: Sort | null;
    /** Load every row (up to ALL_ROWS) instead of the first ROW_CAP */
    all: boolean;
    runningSince: number | null;
    outcome: Outcome | null;
    /** Staged cell edits by row (`rowKey` of its primary key), saved together in one transaction */
    edits: Record<string, RowEdit>;
    /** The rows each change touched, newest last, for undo; a fill or paste is one step */
    undo: RowStep[];
    redo: RowStep[];
    /** Why the last save failed, or why a reload was held back; shown in the footer and the Changes panel */
    editsError: string | null;
    saving: boolean;
    /** A cell (`rowKey` and column name) the grid should select and scroll to, once; it clears it */
    focus: { row: string; column: string } | null;
    /** How the database runs this tab's SELECT, once explained */
    plan: Plan | null;
};

type QueryState = {
    /** At least one, in tab order */
    queries: QueryTab[];
    /** The query tab the editor shows: the active tab, or the last query tab used before a table tab */
    currentQuery: string;
    /** Open table tabs, after the query tabs */
    tables: TableTab[];
    /** The shown tab, query or table */
    activeTab: string;
    /** Run executes the editor selection instead of the whole script when there is one */
    hasSelection: boolean;
    /** Set by the editor on mount; reads the selection only when Run needs it */
    readSelection: () => string;
    /** Newest last, capped at 500 */
    messages: Message[];
    setSql: (sql: string) => void;
    setHasSelection: (hasSelection: boolean) => void;
    setReadSelection: (read: () => string) => void;
    /** The current query tab's connection; its database goes back to the connection's own */
    setConnectionId: (id: string) => void;
    /** The current query tab's database */
    setDatabase: (database: string) => void;
    /** Runs the current query tab, or reloads the table when a table tab is shown */
    run: () => Promise<void>;
    /** Explains the current query tab's selection or script, without running it unless `analyze`; shows the Plan tab */
    explain: (analyze?: boolean) => Promise<void>;
    /** Runs the current query tab's last statement again, keeping all its rows */
    /** Runs result set `at`'s statement again keeping every row (up to ALL_ROWS) */
    loadAllRows: (at?: number) => Promise<void>;
    /** Runs the current query tab's cut-off result again, ordered by the database (null: unordered);
     * false (logged) when it can't, and the caller sorts the loaded rows instead */
    sortResult: (sort: Sort | null) => Promise<boolean>;
    newQuery: () => void;
    /** Saves a query tab (the current one by default): its SQL is what comes back after a restart */
    save: (id?: string) => void;
    renameQuery: (id: string, title: string) => void;
    /** A copy of a query tab, unsaved, right after it */
    duplicateQuery: (id: string) => void;
    /** Opens (or focuses and reloads) a tab with the table's first rows; `filters` replace the tab's filter and WHERE. `show` false opens it behind the current tab */
    openTable: (connectionId: string, database: string, schema: string, table: string, filters?: ColumnFilter[], show?: boolean) => Promise<void>;
    /** Changes a table tab's filter or order and reloads it */
    queryTable: (id: string, change: Partial<Pick<TableTab, 'where' | 'sort' | 'filters' | 'all'>>) => Promise<void>;
    /** Stages cells' new values (null for NULL) on a table tab as one undo step; back to the loaded value unstages a cell */
    stageEdits: (id: string, cells: CellEdit[]) => void;
    /** Steps the staged edits back, or forward with `redo` */
    undoEdits: (id: string, redo?: boolean) => void;
    discardEdits: (id: string) => void;
    /** Stages new rows (column → value; a column left out takes its default) as one undo step */
    addRows: (id: string, rows: Record<string, string | null>[]) => void;
    /** Stages rows to be deleted, or with `restore` takes that back; a new row is just dropped */
    deleteRows: (id: string, pks: RowEdit['pk'][], restore?: boolean) => void;
    /** Takes back everything staged on a row (its `rowKey`) */
    revertRow: (id: string, key: string) => void;
    /** Shows a table tab, with one cell selected in its grid when given; null also clears it once the grid has taken it */
    focusCell: (id: string, cell: TableTab['focus']) => void;
    /** Saves a table tab's edits in one transaction and reloads it; false (error in the Changes panel, opened) when that failed */
    saveEdits: (id: string) => Promise<boolean>;
    closeTab: (id: string) => void;
    /** Tabs waiting on "Save changes?" before they close */
    closing: string[];
    /** Closes tabs, first asking about unsaved changes when any have them */
    requestClose: (ids: string[]) => void;
    /** Answers "Save changes?": save the unsaved ones and close, close without saving, or (null) keep them open.
     * A table tab whose edits fail to save stays open, showing why */
    finishClose: (save: boolean | null) => Promise<void>;
    setActiveTab: (id: string) => void;
    /** The other workspaces' tabs, by workspace id, while one is shown */
    parked: Record<string, Tabs>;
    /** Explains a table tab's SELECT (its WHERE, filters and order), without running it unless `analyze` */
    explainTable: (id: string, analyze?: boolean) => Promise<void>;
    /** Puts tab `id` where tab `to` is, among tabs of the same kind (query or table) */
    moveTab: (id: string, to: string) => void;
    /** Shows another workspace: parks this one's tabs and brings back its own */
    switchWorkspace: (id: string) => void;
    /** Forgets a workspace's parked tabs (a removed one) */
    dropWorkspace: (id: string) => void;
};

/** One workspace's tabs */
type Tabs = Pick<QueryState, 'queries' | 'tables' | 'currentQuery' | 'activeTab'>;
const NO_TABS: Tabs = { queries: [], tables: [], currentQuery: '', activeTab: '' };

/** The query tab the editor and results panel show */
export function currentQuery(s: Pick<QueryState, 'queries' | 'currentQuery'>) {
    return s.queries.find((q) => q.id === s.currentQuery) ?? s.queries[0] ?? NO_QUERY;
}

/** Stands in when every query tab is closed, so readers needn't check; nothing writes to it (its id matches no tab) */
export const NO_QUERY: QueryTab = { ...queryTab(''), id: '' };

/** Rows a result keeps by default, and when all are asked for: query.rs MAX_ROWS and ALL_ROWS */
export const ROW_CAP = 1000;
export const ALL_ROWS = 100_000;

/**
 * One statement that only reads, so running it again to load all its rows changes nothing.
 * A script, or anything that writes, would repeat its changes.
 */
export function rerunnable(sql: string) {
    const text = sql.trim().replace(/;\s*$/, '');
    return (
        !text.includes(';') &&
        // SQL Server runs `SELECT … SELECT …` without a `;` as two statements
        splitStatements(text).length === 1 &&
        /^(select|with|show|values|table|explain|describe|desc|pragma)\b/i.test(text) &&
        !/\b(insert|update|delete|merge|into)\b/i.test(text)
    );
}

function log(ok: boolean, text: string) {
    useQuery.setState((s) => ({ messages: [...s.messages.slice(-499), { at: new Date(), ok, text }] }));
}

/** Runs SQL on a connection, the outcome either way, and logs it to Messages */
/** Explains `sql`, showing the previous plan dimmed meanwhile (`set`), and logs how it went. `what` names
 * what was explained, after "Explain" */
async function runExplain(
    previous: Plan | null,
    connectionId: string,
    sql: string,
    database: string,
    analyze: boolean,
    what: string,
    set: (plan: Plan) => void,
) {
    const since = Date.now();
    set({ runningSince: since, outcome: previous?.outcome ?? null });
    let outcome: Plan['outcome'];
    try {
        outcome = { ok: true, plan: await commands.explainQuery(connectionId, sql, database, analyze) };
    } catch (error) {
        outcome = { ok: false, error: errorMessage(error) };
    }
    const label = `${analyze ? 'Explain analyze' : 'Explain'}${what}`;
    log(
        outcome.ok,
        outcome.ok ? `${label}: ${count(outcome.plan.nodes.length, 'step')} · ${(Date.now() - since).toLocaleString()} ms` : outcome.error,
    );
    set({ runningSince: null, outcome });
}

/** `firstRows`: one read statement, so the database may stop at the row cap instead of sending every row to be counted */
async function execute(
    connectionId: string,
    sql: string,
    database: string,
    allRows = false,
    firstRows = !allRows && rerunnable(sql),
): Promise<Outcome> {
    let outcome: Outcome;
    try {
        outcome = { ok: true, output: await commands.runQuery(connectionId, sql, database, allRows, firstRows) };
    } catch (error) {
        outcome = { ok: false, error: errorMessage(error) };
    }
    log(outcome.ok, outcome.ok ? summary(outcome.output) : outcome.error);
    return outcome;
}

/**
 * Runs a script. Several read-only statements share no state (no variables, temp tables or USE),
 * so each runs at once on its own pooled connection: the wait is the slowest, not the sum. Their
 * results come back as one outcome, the last statement's with the others in `earlier`, as a
 * script run returns them. Anything else runs as one script, in order, on one session
 */
async function executeScript(connectionId: string, sql: string, database: string): Promise<Outcome> {
    const statements = splitStatements(sql).map((st) => st.text);
    if (statements.length < 2 || statements.length > MAX_PARALLEL || !statements.every(rerunnable)) return execute(connectionId, sql, database);
    const outcomes = await Promise.all(statements.map((st) => execute(connectionId, st, database, false, true)));
    const failed = outcomes.find((o) => !o.ok);
    if (failed) return failed;
    const outputs = outcomes.flatMap((o) => (o.ok ? [o.output] : []));
    const last = outputs[outputs.length - 1];
    return {
        ok: true,
        output: {
            ...last,
            elapsedMs: Math.max(...outputs.map((o) => o.elapsedMs)),
            earlier: outputs.slice(0, -1).map(toResultSet),
        },
    };
}

/** Statements run side by side at most (the SQL Server pool holds 4 connections, the rest wait their turn) */
const MAX_PARALLEL = 8;

type Run = NonNullable<QueryTab['lastRun']>;

/** A run's result sets in order: the script's earlier ones, then the last statement's when it
 * returned rows. One set for a single statement (or a failure) */
export function resultSets(last: Outcome | null): Outcome[] {
    // `earlier` is missing when the app's Rust side predates it (a dev build not yet rebuilt)
    if (!last?.ok || !last.output.earlier?.length) return last ? [last] : [];
    const { output } = last;
    const earlier: Outcome[] = output.earlier.map((r) => ({ ok: true, output: { ...r, elapsedMs: output.elapsedMs, earlier: [] } }));
    return output.columns.length ? [...earlier, last] : earlier;
}

/** The statement each result set came from, when the read statements line up one to one with the
 * sets; otherwise none is guessed (empty) */
export function resultStatements(run: Run, sets: number): string[] {
    if (sets <= 1) return [run.sql];
    const reads = splitStatements(run.sql)
        .map((st) => st.text)
        .filter(rerunnable);
    return reads.length === sets ? reads : [];
}

const toResultSet = ({ columns, rows, truncated, rowsAffected, capped }: QueryOutput): ResultSet => ({
    columns,
    rows,
    truncated,
    rowsAffected,
    capped,
});

/** `last` with result set `at` changed (Result 1 is the first of `earlier`, the last one the output itself) */
function updateSet(last: Outcome, at: number, change: Partial<ResultSet>): Outcome {
    if (!last.ok) return last;
    const { earlier } = last.output;
    if (at >= earlier.length) return { ok: true, output: { ...last.output, ...change } };
    return { ok: true, output: { ...last.output, earlier: earlier.map((set, i) => (i === at ? { ...set, ...change } : set)) } };
}

/** COUNT(*) over a read statement; a trailing ORDER BY goes (a derived table can't keep one), unless paging needs it */
function countSql(sql: string) {
    const text = sql.trim().replace(/;\s*$/, '');
    const order = /\border\s+by\s+[^()]*$/i.exec(text);
    const body = order && !/\b(offset|fetch|limit)\b/i.test(order[0]) ? text.slice(0, order.index) : text;
    return `SELECT COUNT(*) FROM (\n${body}\n) AS counted`;
}

/** Counts, in the background, the sets the database stopped sending after the first rows, so they
 * read "1,000 of 113,992" instead of "1,000+". A count that fails leaves the set as it was */
async function countCapped(tabId: string, run: Run, last: Outcome, update: (id: string, patch: Partial<QueryTab>) => void) {
    const sets = resultSets(last);
    const statements = resultStatements(run, sets.length);
    const totals = await Promise.all(
        sets.map(async (set, i) => {
            if (!set.ok || !set.output.capped || !statements[i]) return null;
            try {
                const { rows } = await commands.runQuery(run.connectionId, countSql(statements[i]), run.database, false, false);
                const total = Number(rows[0]?.[0]);
                return Number.isFinite(total) ? total : null;
            } catch {
                return null;
            }
        }),
    );
    if (totals.every((t) => t === null)) return;
    const tab = useQuery.getState().queries.find((q) => q.id === tabId);
    // A newer run, a sort or Load all replaced it meanwhile
    if (tab?.last !== last) return;
    const counted = totals.reduce<Outcome>(
        (out, total, i) => (total === null ? out : updateSet(out, i, { rowsAffected: total, capped: false })),
        last,
    );
    update(tabId, { last: counted });
}

/** A row's key in `TableTab.edits`: its primary key values, in key order */
export const rowKey = (pk: RowEdit['pk']) => JSON.stringify(pk.map(([, v]) => v));

// Counted once per `edits` object: the tab strip, footer, top bar and Changes panel all ask on every store change
const counts = new WeakMap<TableTab['edits'], number>();

/** Cells changed across all rows; a row added or deleted counts once */
export function editCount({ edits }: Pick<TableTab, 'edits'>) {
    let n = counts.get(edits);
    if (n === undefined) {
        n = Object.values(edits).reduce((sum, r) => sum + (r.op ? 1 : Object.keys(r.changes).length), 0);
        counts.set(edits, n);
    }
    return n;
}

/** Cells changed across every table tab */
export const totalEdits = (s: Pick<QueryState, 'tables'>) => s.tables.reduce((n, t) => n + editCount(t), 0);

/** Sets one cell in `edits`, a copy the caller owns, to `to`; undefined or the loaded value unstages it */
function setCell(edits: TableTab['edits'], { pk, column, from, to }: CellEdit) {
    const key = rowKey(pk);
    const changes = { ...edits[key]?.changes };
    if (to === from) delete changes[column];
    else changes[column] = { from, to };
    const op = edits[key]?.op;
    // An added or deleted row stays staged with no cell changes
    if (Object.keys(changes).length || op) edits[key] = { pk, changes, ...(op && { op }) };
    else delete edits[key];
}

/** DELETEs, then one UPDATE per edited row (`UPDATE t SET "a" = 'x', "b" = NULL WHERE <its loaded primary key>`),
 * then INSERTs, so a key deleted can be added again. Numeric columns stay the exact text the database sent */
export function editStatements(kind: Connection['kind'], schema: string, table: string, columns: ResultColumn[], rows: RowEdit[]) {
    const numeric = new Set(columns.filter((c) => c.kind === 'number').map((c) => c.name));
    const assign = ([c, v]: [string, string | null]) => `${quoteName(kind, c)} = ${sqlValue(v, numeric.has(c), kind)}`;
    const name = qualifiedName(kind, schema, table);
    const of = (op: RowEdit['op']) => rows.filter((r) => r.op === op);
    return [
        ...of('delete').map((r) => `DELETE FROM ${name} WHERE ${r.pk.map(assign).join(' AND ')}`),
        ...of(undefined).map((r) => {
            const set = Object.entries(r.changes).map(([c, { to }]) => assign([c, to]));
            return `UPDATE ${name} SET ${set.join(', ')} WHERE ${r.pk.map(assign).join(' AND ')}`;
        }),
        ...of('insert').map((r) => {
            const set = Object.entries(r.changes);
            if (!set.length) return kind === 'mysql' ? `INSERT INTO ${name} () VALUES ()` : `INSERT INTO ${name} DEFAULT VALUES`;
            const cols = set.map(([c]) => ({ name: c, kind: numeric.has(c) ? 'number' : 'text' }));
            // The clipboard's INSERT, without its closing semicolon
            return rowsAsInsert(kind, name, cols, [set.map(([, { to }]) => to)]).slice(0, -1);
        }),
    ];
}

/** The toolbar's choice if it's still open, otherwise the newest connection */
export function activeConnection(connections: Connection[], id: string | null) {
    const picked = connections.find((c) => c.id === id);
    if (picked) return picked;
    // The fallback stays in the shown workspace: a new tab never runs on another client's database
    const shown = connections.filter((c) => inShownWorkspace(c.savedId));
    return shown[shown.length - 1];
}

/** `schema.table`, quoted for the engine */
export function qualifiedName(kind: Connection['kind'], schema: string, table: string) {
    return `${quoteName(kind, schema)}.${quoteName(kind, table)}`;
}

/** LIMIT (SQL Server: TOP) matches the Rust row cap (query.rs MAX_ROWS) so a huge table isn't read to the end */
export function selectSql(
    kind: Connection['kind'],
    schema: string,
    table: string,
    where = '',
    sort: Sort | null = null,
    filters: ColumnFilter[] = [],
    all = false,
) {
    const filter = whereClause(kind, where, filters);
    const order = sort ? ` ORDER BY ${quoteName(kind, sort.column)} ${sort.desc ? 'DESC' : 'ASC'}` : '';
    const limit = all ? ALL_ROWS : ROW_CAP;
    const from = `* FROM ${qualifiedName(kind, schema, table)}${filter}${order}`;
    return kind === 'mssql' ? `SELECT TOP (${limit}) ${from}` : `SELECT ${from} LIMIT ${limit}`;
}

/** " WHERE (…) AND (…)": the typed condition and each column filter, or '' for none. Each part is
 * parenthesized so a condition with OR can't change how the clause reads */
export function whereClause(kind: Connection['kind'], where: string, filters: ColumnFilter[]) {
    const parts = [where.trim(), ...filters.map((f) => filterSql(f, quoteName(kind, f.column), kind))].filter(Boolean);
    return parts.length ? ` WHERE ${parts.map((p) => `(${p})`).join(' AND ')}` : '';
}

/** The tab's database pick when it was made for this connection, else the one Rust says the connection is in */
export function activeDatabase(connection: Connection, tab: Pick<QueryTab, 'connectionId' | 'database'>) {
    return (tab.connectionId === connection.id && tab.database) || connection.database;
}

/** "2 rows · 12 ms", "3 rows affected · 4 ms", with a note when the row cap cut it short */
export function summary({ columns, rowsAffected, rows, truncated, capped, elapsedMs }: QueryOutput) {
    if (capped) return `First ${count(rows.length, 'row')}, the rest not fetched · ${elapsedMs.toLocaleString()} ms`;
    const what = `${count(rowsAffected, 'row')}${columns.length ? '' : ' affected'}`;
    const shown = truncated ? `, first ${rows.length.toLocaleString()} shown` : '';
    return `${what}${shown} · ${elapsedMs.toLocaleString()} ms`;
}

/** A new query tab; `from` passes on its connection and database, like opening a new script in the same place */
function queryTab(title: string, from?: QueryTab): QueryTab {
    return {
        id: crypto.randomUUID(),
        title,
        sql: '',
        saved: '',
        connectionId: from?.connectionId ?? null,
        database: from?.database ?? null,
        runningSince: null,
        last: null,
        lastRun: null,
        serverSort: null,
        plan: null,
    };
}

/** A result's statement again, its rows ordered by the database: by column number, so duplicate or
 * unquotable column names don't matter. SQL Server refuses it when the statement has its own ORDER BY */
export function sortedSql(sql: string, columns: QueryOutput['columns'], sort: Sort | null) {
    const index = sort ? columns.findIndex((c) => c.name === sort.column) : -1;
    if (!sort || index < 0) return sql;
    return `SELECT * FROM (\n${sql.trim().replace(/;\s*$/, '')}\n) AS sorted ORDER BY ${index + 1} ${sort.desc ? 'DESC' : 'ASC'}`;
}

/** "Query 3": one past the highest number in use, so closing Query 2 doesn't hand its name to a new tab */
function nextTitle(queries: QueryTab[]) {
    const used = queries.map((q) => Number(/^Query (\d+)$/.exec(q.title)?.[1] ?? 0));
    return `Query ${Math.max(0, ...used) + 1}`;
}

// persist writes after every set(), i.e. every keystroke; batch those into one write per pause
let pending: { name: string; value: string } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
function flush() {
    clearTimeout(timer);
    if (pending) localStorage.setItem(pending.name, pending.value);
    pending = undefined;
}
const debouncedLocalStorage = {
    getItem: (name: string) => localStorage.getItem(name),
    setItem: (name: string, value: string) => {
        pending = { name, value };
        clearTimeout(timer);
        timer = setTimeout(flush, 400);
    },
    removeItem: (name: string) => localStorage.removeItem(name),
};
// Don’t lose the last 400 ms of typing when the window closes
window.addEventListener('pagehide', flush);

type SavedTab = Pick<QueryTab, 'id' | 'title' | 'saved' | 'connectionId' | 'database'>;
/** The shown workspace's saved query tabs, and the parked workspaces' (workspace: whose `queries` are) */
type Saved = {
    queries: SavedTab[];
    currentQuery: string;
    workspace?: string;
    parked?: Record<string, { queries: SavedTab[]; currentQuery: string }>;
};

/** Only a tab's saved SQL survives a restart */
const savedTabs = (queries: QueryTab[]): SavedTab[] =>
    queries.filter((q) => q.saved !== '').map(({ id, title, saved, connectionId, database }) => ({ id, title, saved, connectionId, database }));

/** The parked workspaces' saved tabs. Persisting runs on every change (each keystroke); parked
 * workspaces change only on a switch, so their part is worked out once per switch */
let parkedCache: { from: QueryState['parked']; saved: NonNullable<Saved['parked']> } | null = null;
function savedParked(parked: QueryState['parked']) {
    if (parkedCache?.from !== parked) {
        const saved = Object.fromEntries(
            Object.entries(parked).map(([id, p]) => [id, { queries: savedTabs(p.queries), currentQuery: p.currentQuery }]),
        );
        parkedCache = { from: parked, saved };
    }
    return parkedCache.saved;
}

/** Saved tabs back as tabs, the last shown one current. Tabs saved before tabs had their own
 * connection come back on the newest one */
function restoreTabs(queries: SavedTab[] | undefined, current: string | undefined): Tabs {
    if (!queries?.length) return NO_TABS;
    const restored = queries.map((q) => ({
        ...queryTab(q.title),
        ...q,
        sql: q.saved,
        connectionId: q.connectionId ?? null,
        database: q.database ?? null,
    }));
    const shown = restored.some((q) => q.id === current) ? current! : restored[0].id;
    return { queries: restored, tables: [], currentQuery: shown, activeTab: shown };
}

/** A query tab has unsaved changes, or a table tab unsaved edits */
/** A table tab before its first load */
export const newTableTab = (t: Pick<TableTab, 'connectionId' | 'database' | 'schema' | 'table'>): TableTab => ({
    ...t,
    id: tableKey(t),
    where: '',
    filters: [],
    sort: null,
    all: false,
    runningSince: null,
    outcome: null,
    edits: {},
    undo: [],
    redo: [],
    editsError: null,
    saving: false,
    focus: null,
    plan: null,
});

export const isDirty = (t: QueryTab | TableTab) => ('edits' in t ? editCount(t) > 0 : t.sql !== t.saved);

export const useQuery = create<QueryState>()(
    persist(
        (set, get) => {
            const updateQuery = (id: string, patch: Partial<QueryTab>) =>
                set((s) => ({ queries: s.queries.map((q) => (q.id === id ? { ...q, ...patch } : q)) }));
            const updateTable = (id: string, patch: Partial<TableTab>) =>
                set((s) => ({ tables: s.tables.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));

            /** Changes a copy of a table tab's edits as one undo step; `change` returns the rows it touched (none: no step) */
            const changeEdits = (id: string, change: (edits: TableTab['edits']) => string[]) => {
                const tab = get().tables.find((t) => t.id === id);
                if (!tab) return;
                const edits = { ...tab.edits };
                const touched = [...new Set(change(edits))];
                if (!touched.length) return;
                const step = touched.map((key) => ({ key, before: tab.edits[key], after: edits[key] }));
                updateTable(id, { edits, undo: [...tab.undo.slice(-99), step], redo: [], editsError: null });
            };

            /** True, with the reason in the footer, while a table tab has unsaved edits: new rows would drop them */
            const holdEdits = (id: string) => {
                const tab = get().tables.find((t) => t.id === id);
                if (!tab || !isDirty(tab)) return false;
                const n = editCount(tab);
                updateTable(id, {
                    editsError: `Save or discard ${n === 1 ? 'this change' : `these ${n} changes`} before reloading, filtering or sorting.`,
                });
                return true;
            };

            /** What Run and Explain act on: the current query tab, its connection, and the selection or else the whole script */
            const target = () => {
                const s = get();
                const tab = currentQuery(s);
                const connection = tab === NO_QUERY ? undefined : activeConnection(useConnections.getState().connections, tab.connectionId);
                return { tab, connection, text: s.readSelection().trim() || tab.sql.trim() };
            };

            /** (Re)loads a table tab with its current filter and order; the old rows stay up while it does */
            const loadTable = async (id: string) => {
                if (holdEdits(id)) return;
                const tab = get().tables.find((t) => t.id === id);
                const connection = useConnections.getState().connections.find((c) => c.id === tab?.connectionId);
                if (!tab || !connection || tab.runningSince !== null) return;
                updateTable(id, { runningSince: Date.now() });
                const sql = selectSql(connection.kind, tab.schema, tab.table, tab.where, tab.sort, tab.filters, tab.all);
                // New rows: an undo step could name rows that aren't there any more
                const outcome = await execute(tab.connectionId, sql, tab.database, tab.all);
                updateTable(id, { runningSince: null, outcome, undo: [], redo: [] });
            };

            return {
                // Nothing open until the user opens something: the workspace shows its empty screen
                queries: [],
                currentQuery: '',
                tables: [],
                activeTab: '',
                hasSelection: false,
                readSelection: () => '',
                messages: [],
                setSql: (sql) => updateQuery(get().currentQuery, { sql }),
                setHasSelection: (hasSelection) => set({ hasSelection }),
                setReadSelection: (readSelection) => set({ readSelection }),
                setConnectionId: (connectionId) => updateQuery(get().currentQuery, { connectionId, database: null }),
                // Pins the connection it's for too: a tab still following "the newest connection" would
                // otherwise drop the pick, since a pick only counts for the tab's own connection
                setDatabase: (database) => {
                    const tab = currentQuery(get());
                    const connection = activeConnection(useConnections.getState().connections, tab.connectionId);
                    updateQuery(tab.id, { database, connectionId: connection?.id ?? tab.connectionId });
                },

                run: async () => {
                    const s = get();
                    if (s.tables.some((t) => t.id === s.activeTab)) return loadTable(s.activeTab);

                    const { tab, connection, text } = target();
                    if (tab.runningSince !== null || !connection || !text) return;
                    const ui = useUi.getState();
                    if (ui.resultsTab === 'plan') ui.setResultsTab('results');

                    // By id: the user may switch tabs while it runs, the result still lands in this one
                    updateQuery(tab.id, { runningSince: Date.now() });
                    const run = { connectionId: connection.id, database: activeDatabase(connection, tab), sql: text };
                    const outcome = await executeScript(run.connectionId, run.sql, run.database);
                    if (outcome.ok) markAccepted(run.sql);
                    updateQuery(tab.id, { runningSince: null, last: outcome, lastRun: run, serverSort: null });
                    void countCapped(tab.id, run, outcome, updateQuery);
                },

                sortResult: async (sort) => {
                    const tab = currentQuery(get());
                    const { lastRun: run, last } = tab;
                    if (!run || !last?.ok || tab.runningSince !== null || !rerunnable(run.sql)) return false;
                    updateQuery(tab.id, { runningSince: Date.now() });
                    // Keeps "Load all rows": a result longer than the cap had them all
                    const sql = sortedSql(run.sql, last.output.columns, sort);
                    const outcome = await execute(run.connectionId, sql, run.database, last.output.rows.length > ROW_CAP);
                    if (!outcome.ok) {
                        log(false, 'Sorted only the loaded rows: the database couldn’t sort the whole result (its error is above).');
                        updateQuery(tab.id, { runningSince: null });
                        return false;
                    }
                    updateQuery(tab.id, { runningSince: null, last: outcome, serverSort: sort });
                    return true;
                },

                explain: async (analyze = false) => {
                    // A table tab has no editor, so nothing to explain
                    if (get().tables.some((t) => t.id === get().activeTab)) return;
                    const { tab, connection, text } = target();
                    useUi.getState().setResultsTab('plan');
                    if (tab.plan?.runningSince != null || !connection || !text) return;
                    await runExplain(tab.plan, connection.id, text, activeDatabase(connection, tab), analyze, '', (plan) =>
                        updateQuery(tab.id, { plan }),
                    );
                },

                loadAllRows: async (at = 0) => {
                    const tab = currentQuery(get());
                    const { lastRun: run, last } = tab;
                    if (!run || !last || tab.runningSince !== null) return;
                    const sets = resultSets(last);
                    const sql = resultStatements(run, sets.length)[at];
                    const set = sets[at];
                    if (!sql || !set || !rerunnable(sql)) return;
                    updateQuery(tab.id, { runningSince: Date.now() });
                    // A database sort only exists for a single result
                    const columns = set.ok ? set.output.columns : [];
                    const outcome = await execute(
                        run.connectionId,
                        sortedSql(sql, columns, sets.length > 1 ? null : tab.serverSort),
                        run.database,
                        true,
                    );
                    // One of several: only its set changes, and a failure (logged in Messages) leaves them all as they were
                    let next = outcome;
                    if (sets.length > 1) {
                        if (!outcome.ok) next = last;
                        else next = updateSet(last, at, toResultSet(outcome.output));
                    }
                    updateQuery(tab.id, { runningSince: null, last: next });
                },

                save: (id = get().currentQuery) => {
                    const tab = get().queries.find((q) => q.id === id);
                    if (tab) updateQuery(id, { saved: tab.sql });
                },

                renameQuery: (id, title) => {
                    if (title.trim()) updateQuery(id, { title: title.trim() });
                },

                duplicateQuery: (id) => {
                    const source = get().queries.find((q) => q.id === id);
                    if (!source) return;
                    const copy = { ...queryTab(`${source.title} copy`, source), sql: source.sql };
                    set((s) => {
                        const queries = [...s.queries];
                        queries.splice(queries.indexOf(source) + 1, 0, copy);
                        return { queries, currentQuery: copy.id, activeTab: copy.id };
                    });
                },

                newQuery: () => {
                    const tab = queryTab(nextTitle(get().queries), currentQuery(get()));
                    set((s) => ({ queries: [...s.queries, tab], currentQuery: tab.id, activeTab: tab.id }));
                },

                openTable: async (connectionId, database, schema, table, filters, show = true) => {
                    const id = tableKey({ connectionId, database, schema, table });
                    if (!get().tables.some((t) => t.id === id)) {
                        const tab = newTableTab({ connectionId, database, schema, table });
                        set((s) => ({ tables: [...s.tables, tab] }));
                    }
                    if (filters && !holdEdits(id)) updateTable(id, { filters, where: '' });
                    if (show) set({ activeTab: id });
                    await loadTable(id);
                },

                queryTable: async (id, change) => {
                    if (holdEdits(id)) return;
                    updateTable(id, change);
                    await loadTable(id);
                },

                // Nothing new (e.g. NULL set on NULLs) touches no row: no empty undo step
                stageEdits: (id, cells) =>
                    changeEdits(id, (edits) =>
                        cells.flatMap((cell) => {
                            const key = rowKey(cell.pk);
                            const before = edits[key]?.changes[cell.column]?.to;
                            if (cell.to === (before === undefined ? cell.from : before)) return [];
                            setCell(edits, cell);
                            return [key];
                        }),
                    ),
                undoEdits: (id, redo = false) => {
                    const tab = get().tables.find((t) => t.id === id);
                    const [take, give] = redo ? (['redo', 'undo'] as const) : (['undo', 'redo'] as const);
                    const steps = tab?.[take];
                    if (!tab || !steps?.length) return;
                    const step = steps[steps.length - 1];
                    const edits = { ...tab.edits };
                    for (const { key, before, after } of step) {
                        const row = redo ? after : before;
                        if (row) edits[key] = row;
                        else delete edits[key];
                    }
                    updateTable(id, { edits, [take]: steps.slice(0, -1), [give]: [...tab[give], step], editsError: null });
                },
                // Undoable from the grid like any other step
                discardEdits: (id) =>
                    changeEdits(id, (edits) => {
                        const keys = Object.keys(edits);
                        for (const k of keys) delete edits[k];
                        return keys;
                    }),
                addRows: (id, rows) => {
                    let first: string | undefined;
                    changeEdits(id, (edits) =>
                        rows.map((row) => {
                            const pk: RowEdit['pk'] = [['', crypto.randomUUID()]];
                            const changes = Object.fromEntries(Object.entries(row).map(([c, to]) => [c, { from: null, to }]));
                            const key = rowKey(pk);
                            first ??= key;
                            edits[key] = { pk, changes, op: 'insert' };
                            return key;
                        }),
                    );
                    // The grid scrolls to the first new row
                    if (first) updateTable(id, { focus: { row: first, column: '' } });
                },
                deleteRows: (id, pks, restore = false) =>
                    changeEdits(id, (edits) =>
                        pks.flatMap((pk) => {
                            const key = rowKey(pk);
                            const row = edits[key];
                            // A new row is just dropped; restoring keeps the row's cell changes
                            if (row?.op === 'insert' || (restore && row?.op === 'delete' && !Object.keys(row.changes).length)) delete edits[key];
                            else if (restore && row?.op === 'delete') edits[key] = { pk, changes: row.changes };
                            else if (!restore && !row?.op) edits[key] = { pk, changes: row?.changes ?? {}, op: 'delete' };
                            else return [];
                            return [key];
                        }),
                    ),
                revertRow: (id, key) =>
                    changeEdits(id, (edits) => {
                        if (!(key in edits)) return [];
                        delete edits[key];
                        return [key];
                    }),
                focusCell: (id, focus) => {
                    updateTable(id, { focus });
                    get().setActiveTab(id);
                },
                saveEdits: async (id) => {
                    const tab = get().tables.find((t) => t.id === id);
                    const kind = useConnections.getState().connections.find((c) => c.id === tab?.connectionId)?.kind;
                    if (!tab || tab.saving || !tab.outcome?.ok) return false;
                    if (!kind) {
                        updateTable(id, { editsError: 'This connection is closed. Reconnect to save.' });
                        useUi.getState().setChangesOpen(true);
                        return false;
                    }
                    const n = editCount(tab);
                    const statements = editStatements(kind, tab.schema, tab.table, tab.outcome.output.columns, Object.values(tab.edits));
                    updateTable(id, { saving: true, editsError: null });
                    try {
                        await commands.applyEdits(tab.connectionId, tab.database, statements);
                    } catch (error) {
                        const message = errorMessage(error);
                        log(false, message);
                        updateTable(id, { saving: false, editsError: message });
                        useUi.getState().setChangesOpen(true);
                        return false;
                    }
                    log(true, `Saved ${n === 1 ? '1 change' : `${n.toLocaleString()} changes`} to ${tab.schema}.${tab.table}`);
                    updateTable(id, { saving: false, edits: {}, undo: [], redo: [] });
                    // Query results read from this table show the saved values too (their edits were staged here)
                    for (const q of get().queries) {
                        const run = q.lastRun;
                        const from = run && run.connectionId === tab.connectionId && sourceTable(run.sql, kind, run.database);
                        if (run && from && tableKey({ connectionId: run.connectionId, ...from }) === id && q.runningSince === null)
                            void execute(run.connectionId, run.sql, run.database).then((last) => updateQuery(q.id, { last }));
                    }
                    await loadTable(id);
                    return true;
                },

                closing: [],
                requestClose: (ids) => {
                    const { queries, tables } = get();
                    if ([...queries, ...tables].some((t) => ids.includes(t.id) && isDirty(t))) set({ closing: ids });
                    else ids.forEach(get().closeTab);
                },
                finishClose: async (saveFirst) => {
                    const { closing, queries, tables, save, saveEdits, closeTab } = get();
                    set({ closing: [] });
                    if (saveFirst === null) return;
                    if (saveFirst) queries.filter((q) => closing.includes(q.id) && isDirty(q)).forEach((q) => save(q.id));
                    for (const id of closing) {
                        const table = tables.find((t) => t.id === id);
                        if (saveFirst && table && isDirty(table) && !(await saveEdits(id))) set({ activeTab: id });
                        else closeTab(id);
                    }
                },

                closeTab: (id) =>
                    set((s) => {
                        const order = [...s.queries, ...s.tables].map((t) => t.id);
                        const queries = s.queries.filter((q) => q.id !== id);
                        const tables = s.tables.filter((t) => t.id !== id);
                        const left = [...queries, ...tables].map((t) => t.id);
                        // Closing the shown tab shows the one that slides into its place, else the one before it
                        const i = order.indexOf(id);
                        // Nothing left: '' shows the empty screen
                        const activeTab = s.activeTab !== id ? s.activeTab : (left[Math.min(i, left.length - 1)] ?? '');
                        const current = queries.some((q) => q.id === s.currentQuery)
                            ? s.currentQuery
                            : (queries[Math.min(i, queries.length - 1)]?.id ?? '');
                        return { queries, tables, activeTab, currentQuery: queries.some((q) => q.id === activeTab) ? activeTab : current };
                    }),

                explainTable: async (id, analyze = false) => {
                    const tab = get().tables.find((t) => t.id === id);
                    const connection = useConnections.getState().connections.find((c) => c.id === tab?.connectionId);
                    if (!tab || !connection || tab.plan?.runningSince != null) return;
                    const sql = selectSql(connection.kind, tab.schema, tab.table, tab.where, tab.sort, tab.filters, tab.all);
                    await runExplain(tab.plan, connection.id, sql, tab.database, analyze, ` ${tab.schema}.${tab.table}`, (plan) =>
                        updateTable(id, { plan }),
                    );
                },
                moveTab: (id, to) =>
                    set((s) => {
                        const move = <T extends { id: string }>(list: T[]) => {
                            const from = list.findIndex((t) => t.id === id);
                            const at = list.findIndex((t) => t.id === to);
                            if (from < 0 || at < 0) return list;
                            const next = [...list];
                            next.splice(at, 0, ...next.splice(from, 1));
                            return next;
                        };
                        return { queries: move(s.queries), tables: move(s.tables) };
                    }),
                parked: {},
                switchWorkspace: (id) => {
                    const from = useUi.getState().workspace;
                    if (id === from) return;
                    const s = get();
                    const { [id]: next = NO_TABS, ...rest } = s.parked;
                    // shortcut: a query still running when its workspace is parked drops its result; keep
                    // per-workspace tab state in the tab itself if that matters
                    // The UI store first, so persisting this change records the new workspace
                    useUi.setState({ workspace: id, inspected: null });
                    set({
                        ...next,
                        parked: { ...rest, [from]: { queries: s.queries, tables: s.tables, currentQuery: s.currentQuery, activeTab: s.activeTab } },
                    });
                },
                dropWorkspace: (id) =>
                    set((s) => {
                        const { [id]: _, ...rest } = s.parked;
                        return { parked: rest };
                    }),

                setActiveTab: (activeTab) =>
                    set((s) => ({ activeTab, currentQuery: s.queries.some((q) => q.id === activeTab) ? activeTab : s.currentQuery })),
            };
        },
        {
            name: 'qc-query',
            version: 2,
            // Only saved SQL survives a restart, and only tabs saved at least once; unsaved edits, results,
            // table tabs and connections end with the app
            partialize: (s): Saved => ({
                queries: savedTabs(s.queries),
                currentQuery: s.currentQuery,
                workspace: useUi.getState().workspace,
                parked: savedParked(s.parked),
            }),
            merge: (saved, current) => {
                const { queries, currentQuery: id, workspace, parked } = (saved ?? {}) as Partial<Saved>;
                // These tabs are this workspace's: the UI store, restored apart, must show the same one
                if (workspace) useUi.setState({ workspace });
                return {
                    ...current,
                    ...restoreTabs(queries, id),
                    parked: Object.fromEntries(Object.entries(parked ?? {}).map(([w, p]) => [w, restoreTabs(p.queries, p.currentQuery)])),
                };
            },
            // Version 0 kept one draft, version 1 every tab's draft: both count as saved, so nothing is lost on upgrade
            migrate: (old, version) => {
                if (version === 0) {
                    const first = { ...queryTab('Query 1'), saved: (old as { sql?: string }).sql ?? '' };
                    return { queries: [first], currentQuery: first.id };
                }
                if (version === 1) {
                    const v1 = old as { queries: (Omit<Saved['queries'][number], 'saved'> & { sql: string })[]; currentQuery: string };
                    return { ...v1, queries: v1.queries.map(({ sql, ...q }) => ({ ...q, saved: sql })) };
                }
                return old as Saved;
            },
            storage: createJSONStorage(() => debouncedLocalStorage),
        },
    ),
);
