import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { commands, type QueryOutput, type QueryPlan, type ResultColumn } from '@/bindings';
import { count } from '@/lib/utils';
import { errorMessage, useConnections, type Connection } from './connections';
import { filterSql, type ColumnFilter } from '@/lib/column-filter';
import { quoteName, sqlValue } from '@/lib/sql-quote';
import { tableKey } from '@/lib/table-details';
import { markAccepted } from '@/lib/sql-lint';
import { useUi } from './ui';

export type Message = { at: Date; ok: boolean; text: string };

export type Outcome = { ok: true; output: QueryOutput } | { ok: false; error: string };

export type Sort = { column: string; desc: boolean };

/** A query tab's last Explain; the previous outcome stays while a new one is in flight */
export type Plan = {
    runningSince: number | null;
    outcome: { ok: true; plan: QueryPlan } | { ok: false; error: string } | null;
};

/** One row's staged cell edits */
export type RowEdit = {
    /** Primary key column → value as loaded: the UPDATE finds the row by these, so editing the key itself is safe */
    pk: [string, string][];
    /** Changed column → its loaded value and the new one */
    changes: Record<string, { from: string | null; to: string | null }>;
};

/** One cell's new value; `from` is its loaded value, and staging that unstages the cell */
export type CellEdit = { pk: RowEdit['pk']; column: string; from: string | null; to: string | null };

/** A cell one undo step changed: its staged value before and after (undefined: nothing staged) */
type CellStep = Omit<CellEdit, 'to'> & { before: string | null | undefined; after: string | null | undefined };

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
    /** The cells each change touched, newest last, for undo; a fill or paste is one step */
    undo: CellStep[][];
    redo: CellStep[][];
    /** Why the last save failed, or why a reload was held back; shown in the footer and the Changes panel */
    editsError: string | null;
    saving: boolean;
    /** A cell (`rowKey` and column name) the grid should select and scroll to, once; it clears it */
    focus: { row: string; column: string } | null;
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
    loadAllRows: () => Promise<void>;
    newQuery: () => void;
    /** Saves a query tab (the current one by default): its SQL is what comes back after a restart */
    save: (id?: string) => void;
    renameQuery: (id: string, title: string) => void;
    /** A copy of a query tab, unsaved, right after it */
    duplicateQuery: (id: string) => void;
    /** Opens (or focuses and reloads) a tab with the table's first rows; `filters` replace the tab's filter and WHERE */
    openTable: (connectionId: string, database: string, schema: string, table: string, filters?: ColumnFilter[]) => Promise<void>;
    /** Changes a table tab's filter or order and reloads it */
    queryTable: (id: string, change: Partial<Pick<TableTab, 'where' | 'sort' | 'filters' | 'all'>>) => Promise<void>;
    /** Stages cells' new values (null for NULL) on a table tab as one undo step; back to the loaded value unstages a cell */
    stageEdits: (id: string, cells: CellEdit[]) => void;
    /** Steps the staged edits back, or forward with `redo` */
    undoEdits: (id: string, redo?: boolean) => void;
    discardEdits: (id: string) => void;
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
};

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
        /^(select|with|show|values|table|explain|describe|desc|pragma)\b/i.test(text) &&
        !/\b(insert|update|delete|merge|into)\b/i.test(text)
    );
}

function log(ok: boolean, text: string) {
    useQuery.setState((s) => ({ messages: [...s.messages.slice(-499), { at: new Date(), ok, text }] }));
}

/** Runs SQL on a connection, the outcome either way, and logs it to Messages */
async function execute(connectionId: string, sql: string, database: string, allRows = false): Promise<Outcome> {
    let outcome: Outcome;
    try {
        outcome = { ok: true, output: await commands.runQuery(connectionId, sql, database, allRows) };
    } catch (error) {
        outcome = { ok: false, error: errorMessage(error) };
    }
    log(outcome.ok, outcome.ok ? summary(outcome.output) : outcome.error);
    return outcome;
}

/** A row's key in `TableTab.edits`: its primary key values, in key order */
export const rowKey = (pk: RowEdit['pk']) => JSON.stringify(pk.map(([, v]) => v));

// Counted once per `edits` object: the tab strip, footer, top bar and Changes panel all ask on every store change
const counts = new WeakMap<TableTab['edits'], number>();

/** Cells changed across all rows */
export function editCount({ edits }: Pick<TableTab, 'edits'>) {
    let n = counts.get(edits);
    if (n === undefined) {
        n = Object.values(edits).reduce((sum, r) => sum + Object.keys(r.changes).length, 0);
        counts.set(edits, n);
    }
    return n;
}

/** Cells changed across every table tab */
export const totalEdits = (s: Pick<QueryState, 'tables'>) => s.tables.reduce((n, t) => n + editCount(t), 0);

/** Sets one cell in `edits`, a copy the caller owns, to `to`; undefined or the loaded value unstages it */
function setCell(edits: TableTab['edits'], { pk, column, from }: Omit<CellEdit, 'to'>, to: string | null | undefined) {
    const key = rowKey(pk);
    const changes = { ...edits[key]?.changes };
    if (to === undefined || to === from) delete changes[column];
    else changes[column] = { from, to };
    if (Object.keys(changes).length) edits[key] = { pk, changes };
    else delete edits[key];
}

/** One UPDATE per edited row: `UPDATE t SET "a" = 'x', "b" = NULL WHERE <its loaded primary key>`. Numeric
 * columns stay the exact text the database sent */
export function editStatements(kind: Connection['kind'], schema: string, table: string, columns: ResultColumn[], rows: RowEdit[]) {
    const numeric = new Set(columns.filter((c) => c.kind === 'number').map((c) => c.name));
    const assign = ([c, v]: [string, string | null]) => `${quoteName(kind, c)} = ${sqlValue(v, numeric.has(c), kind)}`;
    return rows.map((r) => {
        const set = Object.entries(r.changes).map(([c, { to }]) => assign([c, to]));
        return `UPDATE ${qualifiedName(kind, schema, table)} SET ${set.join(', ')} WHERE ${r.pk.map(assign).join(' AND ')}`;
    });
}

/** The toolbar's choice if it's still open, otherwise the newest connection */
export function activeConnection(connections: Connection[], id: string | null) {
    return connections.find((c) => c.id === id) ?? connections[connections.length - 1];
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
export function summary({ columns, rowsAffected, rows, truncated, elapsedMs }: QueryOutput) {
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
        plan: null,
    };
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

type Saved = { queries: Pick<QueryTab, 'id' | 'title' | 'saved' | 'connectionId' | 'database'>[]; currentQuery: string };

/** A query tab has unsaved changes, or a table tab unsaved edits */
export const isDirty = (t: QueryTab | TableTab) => ('edits' in t ? editCount(t) > 0 : t.sql !== t.saved);

export const useQuery = create<QueryState>()(
    persist(
        (set, get) => {
            const updateQuery = (id: string, patch: Partial<QueryTab>) =>
                set((s) => ({ queries: s.queries.map((q) => (q.id === id ? { ...q, ...patch } : q)) }));
            const updateTable = (id: string, patch: Partial<TableTab>) =>
                set((s) => ({ tables: s.tables.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));

            /** Sets a table tab's staged edits, with the cells that changed as one undo step */
            const setEdits = (tab: TableTab, edits: TableTab['edits'], step: CellStep[]) =>
                updateTable(tab.id, { edits, undo: [...tab.undo.slice(-99), step], redo: [], editsError: null });

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
                setDatabase: (database) => updateQuery(get().currentQuery, { database }),

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
                    const outcome = await execute(run.connectionId, run.sql, run.database);
                    if (outcome.ok) markAccepted(run.sql);
                    updateQuery(tab.id, { runningSince: null, last: outcome, lastRun: run });
                },

                explain: async (analyze = false) => {
                    // A table tab has no editor, so nothing to explain
                    if (get().tables.some((t) => t.id === get().activeTab)) return;
                    const { tab, connection, text } = target();
                    useUi.getState().setResultsTab('plan');
                    if (tab.plan?.runningSince != null || !connection || !text) return;
                    const since = Date.now();
                    updateQuery(tab.id, { plan: { runningSince: since, outcome: tab.plan?.outcome ?? null } });
                    let outcome: Plan['outcome'];
                    try {
                        const plan = await commands.explainQuery(connection.id, text, activeDatabase(connection, tab), analyze);
                        outcome = { ok: true, plan };
                    } catch (error) {
                        outcome = { ok: false, error: errorMessage(error) };
                    }
                    const what = analyze ? 'Explain analyze' : 'Explain';
                    log(
                        outcome.ok,
                        outcome.ok
                            ? `${what}: ${count(outcome.plan.nodes.length, 'step')} · ${(Date.now() - since).toLocaleString()} ms`
                            : outcome.error,
                    );
                    updateQuery(tab.id, { plan: { runningSince: null, outcome } });
                },

                loadAllRows: async () => {
                    const tab = currentQuery(get());
                    const run = tab.lastRun;
                    if (!run || tab.runningSince !== null || !rerunnable(run.sql)) return;
                    updateQuery(tab.id, { runningSince: Date.now() });
                    const outcome = await execute(run.connectionId, run.sql, run.database, true);
                    updateQuery(tab.id, { runningSince: null, last: outcome });
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

                openTable: async (connectionId, database, schema, table, filters) => {
                    const id = tableKey({ connectionId, database, schema, table });
                    if (!get().tables.some((t) => t.id === id)) {
                        const tab: TableTab = {
                            id,
                            connectionId,
                            database,
                            schema,
                            table,
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
                        };
                        set((s) => ({ tables: [...s.tables, tab] }));
                    }
                    if (filters && !holdEdits(id)) updateTable(id, { filters, where: '' });
                    set({ activeTab: id });
                    await loadTable(id);
                },

                queryTable: async (id, change) => {
                    if (holdEdits(id)) return;
                    updateTable(id, change);
                    await loadTable(id);
                },

                stageEdits: (id, cells) => {
                    const tab = get().tables.find((t) => t.id === id);
                    if (!tab) return;
                    const edits = { ...tab.edits };
                    const step: CellStep[] = [];
                    for (const cell of cells) {
                        const before = edits[rowKey(cell.pk)]?.changes[cell.column]?.to;
                        if (cell.to === (before === undefined ? cell.from : before)) continue;
                        step.push({ pk: cell.pk, column: cell.column, from: cell.from, before, after: cell.to === cell.from ? undefined : cell.to });
                        setCell(edits, cell, cell.to);
                    }
                    // Nothing new (e.g. NULL set on NULLs): no empty undo step
                    if (step.length) setEdits(tab, edits, step);
                },
                undoEdits: (id, redo = false) => {
                    const tab = get().tables.find((t) => t.id === id);
                    const [take, give] = redo ? (['redo', 'undo'] as const) : (['undo', 'redo'] as const);
                    const steps = tab?.[take];
                    if (!tab || !steps?.length) return;
                    const step = steps[steps.length - 1];
                    const edits = { ...tab.edits };
                    // Backwards when undoing, so a cell a step touched twice ends where it started
                    if (redo) for (const c of step) setCell(edits, c, c.after);
                    else for (const c of [...step].reverse()) setCell(edits, c, c.before);
                    updateTable(id, { edits, [take]: steps.slice(0, -1), [give]: [...tab[give], step], editsError: null });
                },
                // Undoable from the grid like any other step
                discardEdits: (id) => {
                    const tab = get().tables.find((t) => t.id === id);
                    const step = Object.values(tab?.edits ?? {}).flatMap(({ pk, changes }) =>
                        Object.entries(changes).map(([column, { from, to }]) => ({ pk, column, from, before: to, after: undefined })),
                    );
                    if (tab && step.length) setEdits(tab, {}, step);
                },
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
                queries: s.queries
                    .filter((q) => q.saved !== '')
                    .map(({ id, title, saved, connectionId, database }) => ({ id, title, saved, connectionId, database })),
                currentQuery: s.currentQuery,
            }),
            merge: (saved, current) => {
                const { queries, currentQuery: id } = (saved ?? {}) as Partial<Saved>;
                if (!queries?.length) return current;
                // Tabs saved before tabs had their own connection come back on the newest one
                const restored = queries.map((q) => ({
                    ...queryTab(q.title),
                    ...q,
                    sql: q.saved,
                    connectionId: q.connectionId ?? null,
                    database: q.database ?? null,
                }));
                const shown = restored.some((q) => q.id === id) ? id! : restored[0].id;
                return { ...current, queries: restored, currentQuery: shown, activeTab: shown };
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
