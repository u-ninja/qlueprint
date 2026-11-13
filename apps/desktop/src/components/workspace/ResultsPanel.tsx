import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { CircleAlert, Plus, TriangleAlert } from 'lucide-react';
import type { PlanNode, QueryPlan } from '@/bindings';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Skeleton } from '@/components/ui/loading';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { schemasOf } from '@/components/shell/Explorer';
import { useConnections, type Connection } from '@/stores/connections';
import {
    activeConnection,
    activeDatabase,
    currentQuery,
    newTableTab,
    rowKey,
    type RowEdit,
    rerunnable,
    summary,
    resultSets,
    resultStatements,
    useQuery,
    type Outcome,
    type Plan,
    type QueryTab,
    type TableTab,
} from '@/stores/query';
import { useUi, type Inspected, type ResultsTab } from '@/stores/ui';
import { useCopy } from '@/lib/use-copy';
import { filterRows, type ColumnFilter } from '@/lib/column-filter';
import { sourceTable } from '@/lib/columns';
import { tableKey, useTableDetails, type Related } from '@/lib/table-details';
import { ResultsGrid, type Editor } from './ResultsGrid';
import { useFields } from './CellEditor';
import { LoadAllButton, shapeChips, StatusBar, TableStatusBar, type Shape } from './StatusBar';
import { WhereBar } from './WhereBar';
import { cn, explainShortcut, runShortcut } from '@/lib/utils';

// Figures and meta in the tab strip: the running timer and, once done, the result summary in its place
const meta = 'font-mono text-[11px] tabular-nums';

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const seconds = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// Ticks on its own so only this label re-renders while a query runs
function Elapsed({ since }: { since: number }) {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 100);
        return () => clearInterval(timer);
    }, []);
    // aria-hidden: inside a live region, a 100 ms tick would be read out continuously.
    // Right-aligned in a fixed width, so 9.9 s becoming 10.0 s doesn't shift the label beside it
    return (
        <span className={cn(meta, 'inline-block min-w-[6ch] text-right whitespace-nowrap')} aria-hidden>
            {`${seconds.format((now - since) / 1000)}\u00a0s`}
        </span>
    );
}

/** A thin accent segment sweeping along the bottom edge of the tab strip, i.e. the top of the results */
function RunningBar() {
    return (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden">
            {/* Reduced motion: the segment stops and becomes a static full-width line */}
            <div className="h-full w-1/4 animate-sweep bg-primary motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-60" />
        </div>
    );
}

// Quiet on purpose: the bar is the motion and the strip has the timer, the center only says where
function Running({ doing = 'Running' }: { doing?: string }) {
    const connectionId = useQuery((s) => currentQuery(s).connectionId);
    const label = useConnections((s) => activeConnection(s.connections, connectionId)?.label);
    return (
        <div className="grid h-full place-items-center px-6 text-fg3">
            <span className="max-w-full truncate" title={label}>
                {doing} on {label}…
            </span>
        </div>
    );
}

function Empty({ text, keys, does }: { text: string; keys: string; does: string }) {
    return (
        <div className="grid h-full place-items-center text-fg3">
            <div className="flex flex-col items-center gap-2">
                <span>{text}</span>
                <span className="text-xs">
                    <Kbd className="px-1.5 font-mono text-fg2">{keys}</Kbd> {does} the query, or just the selected part
                </span>
            </div>
        </div>
    );
}

function Failed({ error, title = 'Query failed' }: { error: string; title?: string }) {
    return (
        <div role="alert" className="flex gap-3 overflow-auto px-5 py-4.5">
            <CircleAlert className="mt-px size-4 flex-none text-danger" aria-hidden />
            <div className="flex min-w-0 flex-col gap-1.5">
                <span className="font-medium">{title}</span>
                <span className="font-mono text-xs wrap-anywhere whitespace-pre-wrap text-fg2">{error}</span>
            </div>
        </div>
    );
}

function OutcomeView({ outcome, ...grid }: { outcome: Outcome } & Omit<ComponentProps<typeof ResultsGrid>, 'output'>) {
    if (!outcome.ok) return <Failed error={outcome.error} />;
    const { output } = outcome;
    if (output.columns.length) return <ResultsGrid output={output} {...grid} />;
    return <div className="grid h-full place-items-center text-fg3">{summary(output)}</div>;
}

type Run = QueryTab['lastRun'];

/**
 * Sort and filters for a query result, applied to its loaded rows. Tagged with the run they were set
 * on, so a new run starts unsorted and unfiltered without an effect, while loading all rows or a
 * re-sort by the database keeps them. A cut-off result's sort runs it again, ordered by the database,
 * so the order covers every row; if the database refuses, the loaded rows are sorted (`sortResult`)
 */
function useShape(run: Run, at: number) {
    const [state, setState] = useState<{ for: Run; at: number } & Shape>({ for: null, at: 0, sort: null, filters: [] });
    const mine = (s: typeof state) => s.for === run && s.at === at;
    const shape: Shape = mine(state) ? state : { sort: null, filters: [] };
    const set = (change: Partial<Shape>) => setState((prev) => ({ ...(mine(prev) ? prev : shape), ...change, for: run, at }));
    const change = (change: Partial<Shape>) => {
        const { last, serverSort } = currentQuery(useQuery.getState());
        // The database sorts a cut-off result; clearing its sort runs it again to get the original order back.
        // With every row loaded, the grid sorts them itself
        const viaDatabase = last?.ok && (last.output.truncated || (serverSort !== null && !change.sort));
        if (!('sort' in change) || !viaDatabase) return set(change);
        void useQuery
            .getState()
            .sortResult(change.sort ?? null)
            .then(() => set(change));
    };
    return [shape, change] as const;
}

/** The shown result set (Result 1, 2…), for the run it was picked on: a new run starts on Result 1 */
function useResultSet(run: Run) {
    // Tagged with the run, not its outcome: a count or Load all updates the outcome and keeps the pick
    const [picked, setPicked] = useState<{ for: Run; at: number }>({ for: null, at: 0 });
    const at = picked.for === run ? picked.at : 0;
    return [at, (at: number) => setPicked({ for: run, at })] as const;
}

type ResultSetProps = { at: number; setAt: (at: number) => void; shape: Shape; setShape: (change: Partial<Shape>) => void };

/** The run's result sets, the shown one (`at`, kept in range) and the statement it came from: its own
 * statement makes a single-table SELECT among several editable, and lets it load all its rows */
function useShownSet(picked: number) {
    const last = useQuery((s) => currentQuery(s).last);
    const lastRun = useQuery((s) => currentQuery(s).lastRun);
    return useMemo(() => {
        const sets = resultSets(last);
        const at = Math.max(0, Math.min(picked, sets.length - 1));
        const statement = lastRun ? resultStatements(lastRun, sets.length)[at] : undefined;
        return { last, lastRun, sets, at, shown: sets[at] ?? last, statement };
    }, [last, lastRun, picked]);
}

function ResultsView({ at: picked, setAt, shape, setShape }: ResultSetProps) {
    const runningSince = useQuery((s) => currentQuery(s).runningSince);
    const connectionId = useQuery((s) => currentQuery(s).connectionId);
    const engine = useConnections((s) => activeConnection(s.connections, connectionId)?.kind);
    const { last, lastRun, sets, at, shown, statement } = useShownSet(picked);
    const from = useMemo(
        () => (statement && engine && lastRun ? sourceTable(statement, engine, lastRun.database) : undefined),
        [statement, engine, lastRun],
    );

    if (!last || !shown) return runningSince === null ? <Empty text="Run a query to see results here" keys={runShortcut} does="runs" /> : <Running />;
    const view = {
        outcome: shown,
        engine,
        sort: shape.sort,
        onSort: (sort: Shape['sort']) => setShape({ sort }),
        filters: shape.filters,
        onFiltersChange: (filters: ColumnFilter[]) => setShape({ filters }),
    };
    return (
        // The previous result stays visible but dims until the new one returns; the tab strip says so.
        // The dim waits 300 ms so a quick re-run swaps the result without the grid flashing, and lifts at once
        <div className={cn('flex h-full flex-col transition-opacity duration-200', runningSince !== null && 'opacity-50 delay-300')}>
            {sets.length > 1 && (
                <div
                    role="tablist"
                    aria-label="Result sets"
                    className="flex h-8 flex-none items-center gap-1 overflow-x-auto border-b border-border-soft px-2"
                >
                    {sets.map((set, i) => (
                        <button
                            key={i}
                            type="button"
                            role="tab"
                            aria-selected={i === at}
                            onClick={() => setAt(i)}
                            className={cn(
                                'flex h-6 flex-none items-center gap-1.5 rounded-[5px] px-2 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                                i === at ? 'bg-primary-soft text-foreground' : 'text-fg3 hover:bg-hover hover:text-fg2',
                            )}
                        >
                            Result {i + 1}
                            {set.ok && (
                                <span className="font-mono text-[10.5px] text-fg4 tabular-nums">
                                    {set.output.capped ? `${set.output.rows.length.toLocaleString()}+` : set.output.rowsAffected.toLocaleString()}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
            )}
            <div className="min-h-0 flex-1">
                {from && lastRun ? (
                    <TableQueryOutcome key={at} from={{ connectionId: lastRun.connectionId, ...from }} {...view} />
                ) : (
                    <OutcomeView key={at} {...view} />
                )}
            </div>
        </div>
    );
}

/** A query result read from one table: editable like that table's tab, with its edits staged there */
function TableQueryOutcome({ from, ...view }: { from: Inspected } & ComponentProps<typeof OutcomeView>) {
    const open = useQuery((s) => s.tables.find((t) => t.id === tableKey(from)));
    // The grid's rows are the query's; focus belongs to the table tab's own grid
    const { editor, readOnly } = useTableEditing({ ...(open ?? newTableTab(from)), outcome: view.outcome, focus: null });
    return (
        <div className="flex h-full flex-col">
            {/* Like a table tab's footer: why these rows can't be edited (a view, no primary key, the key not selected) */}
            {readOnly && (
                <p role="status" className="flex-none truncate border-b border-border-soft px-3 py-1 text-xs text-fg3" title={readOnly}>
                    {readOnly} · {from.schema}.{from.table}
                </p>
            )}
            <div className="min-h-0 flex-1">
                <OutcomeView {...view} editor={editor} />
            </div>
        </div>
    );
}

/** Right side of the tab strip: what's running, or what the shown result is */
function Status() {
    const runningSince = useQuery((s) => currentQuery(s).runningSince);
    const explainingSince = useQuery((s) => currentQuery(s).plan?.runningSince ?? null);
    const last = useQuery((s) => currentQuery(s).last);
    const since = runningSince ?? explainingSince;
    if (since !== null) {
        const text = runningSince === null ? 'Explaining…' : last ? 'Running, previous result shown' : 'Running…';
        return (
            <span role="status" className="flex items-baseline gap-2 whitespace-nowrap">
                <span className="min-w-0 truncate" title={text}>
                    {text}
                </span>
                <Elapsed since={since} />
            </span>
        );
    }
    // Rows and time are in the footer; a statement without rows says what it did here
    return last?.ok && !last.output.columns.length ? <span className={meta}>{summary(last.output)}</span> : null;
}

function MessagesView() {
    const messages = useQuery((s) => s.messages);
    if (!messages.length) return <div className="grid h-full place-items-center text-fg3">No messages yet</div>;
    return (
        <ol className="h-full overflow-auto py-2 font-mono text-xs select-text">
            {messages.map((m, i) => (
                <li key={i} className="flex items-baseline gap-3.5 px-4 py-1">
                    <span className="flex-none text-fg4 tabular-nums">{time.format(m.at)}</span>
                    <span className={cn('w-11 flex-none', m.ok ? 'text-success' : 'text-danger')}>{m.ok ? 'OK' : 'ERROR'}</span>
                    <span className="min-w-0 whitespace-pre-wrap text-fg2">{m.text}</span>
                </li>
            ))}
        </ol>
    );
}

const figures = 'text-right font-mono text-[11.5px] tabular-nums';
const planGrid = 'grid grid-cols-[minmax(0,1fr)_minmax(3rem,13.75rem)_5.5rem_9rem] items-center gap-4 px-4';
// One step deeper per level, as in the mockup
const indent = (depth: number) => ({ paddingLeft: depth * 18 });

/** "0.05", "12.2", "1,420": fewer decimals as the number grows */
const figure = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 2 : n < 100 ? 1 : 0 });
const rows = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

/**
 * Each node's own share of `value`: its figure minus its direct children's, which the engines count
 * in it. One pass over the pre-order list, with the open ancestors on a stack
 */
function ownShares(nodes: PlanNode[], value: (n: PlanNode) => number | null | undefined) {
    const own = nodes.map((n) => value(n) ?? null);
    const stack: number[] = [];
    nodes.forEach((n, i) => {
        stack.length = Math.min(stack.length, n.depth);
        const parent = stack[stack.length - 1];
        const v = own[i];
        if (parent !== undefined && v !== null && own[parent] !== null) own[parent] = Math.max(0, own[parent]! - v);
        stack.push(i);
    });
    return own;
}

/** The table a plan step reads, if the connection's explorer knows one by that name; MySQL's schemas are its databases */
function tableNamed(c: Connection, database: string, name: string): Inspected | undefined {
    const mysql = c.kind === 'mysql';
    const schemas = mysql ? c.schemas : schemasOf(c, database);
    // The tab's own database first, where MySQL resolves an unqualified name
    const schema = [...schemas.filter((s) => s.name === database), ...schemas].find((s) => s.tables.some((t) => t.name === name));
    return schema && { connectionId: c.id, database: mysql ? c.database : database, schema: schema.name, table: name };
}

/** Estimated rows, and when analyzed the actual ones, in the warning colour when they're 10× apart */
function Rows({ node }: { node: PlanNode }) {
    const { estRows: est, actualRows: actual } = node;
    if (actual == null) return <span className={cn(figures, 'text-fg3')}>{est == null ? '—' : rows(est)}</span>;
    const missed = est != null && Math.max(est, actual) >= 10 * Math.max(Math.min(est, actual), 1);
    return (
        <span
            className={cn(figures, 'truncate text-fg3')}
            title={est == null ? undefined : `Estimated ${rows(est)} rows${node.loops && node.loops > 1 ? ' per loop' : ''}, got ${rows(actual)}`}
        >
            {est != null && <span className="text-fg4">{rows(est)} → </span>}
            <span className={missed ? 'text-warning' : undefined}>{rows(actual)}</span>
        </span>
    );
}

function PlanSteps({ plan }: { plan: QueryPlan }) {
    const connectionId = useQuery((s) => currentQuery(s).connectionId);
    const picked = useQuery((s) => currentQuery(s).database);
    const connection = useConnections((s) => activeConnection(s.connections, connectionId));
    const inspect = useUi((s) => s.inspect);
    const { nodes, analyzed } = plan;
    // The bars: time when it ran, else the planner's cost
    const value = (n: PlanNode) => (analyzed ? n.actualMs : n.estCost);
    const own = useMemo(() => ownShares(nodes, (n) => (analyzed ? n.actualMs : n.estCost)), [nodes, analyzed]);
    const max = Math.max(0, ...nodes.map((n) => value(n) ?? 0));
    // The one accent: the step that costs the most on its own
    const hottest = own.reduce<number>((best, v, i) => (v !== null && v > (own[best] ?? -1) ? i : best), -1);
    const database = connection && activeDatabase(connection, { connectionId, database: picked });

    if (!nodes.length) return <div className="grid h-full place-items-center text-fg3">The database returned no steps for this query</div>;
    return (
        <div className="h-full overflow-auto py-1.5">
            <div className={cn(planGrid, 'py-1.5 text-[11px] text-fg4')} aria-hidden>
                <span>Step</span>
                <span />
                <span className="text-right">{analyzed ? 'Time' : 'Cost'}</span>
                <span className="text-right">{analyzed ? 'Rows est. → actual' : 'Rows (est.)'}</span>
            </div>
            <ol>
                {nodes.map((n, i) => {
                    const v = value(n);
                    const table = n.relation && connection && database !== undefined ? tableNamed(connection, database, n.relation) : undefined;
                    return (
                        <li key={i} className={cn(planGrid, 'py-1.5 text-[12.5px] hover:bg-hover')}>
                            <div className="flex min-w-0 items-center gap-2" style={indent(n.depth)}>
                                {n.depth > 0 && (
                                    <span className="font-mono text-fg4" aria-hidden>
                                        ↳
                                    </span>
                                )}
                                <span className="font-medium whitespace-nowrap">{n.kind}</span>
                                {n.relation &&
                                    (table ? (
                                        <button
                                            type="button"
                                            onClick={() => inspect(table)}
                                            title={`Show ${table.schema}.${n.relation} in the inspector`}
                                            className="flex-none rounded-sm font-mono text-[11.5px] text-fg2 underline-offset-2 hover:text-primary-text hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                                        >
                                            {n.relation}
                                        </button>
                                    ) : (
                                        <span className="flex-none font-mono text-[11.5px] text-fg2">{n.relation}</span>
                                    ))}
                                {n.detail && (
                                    <span className="min-w-0 truncate font-mono text-[11.5px] text-fg3" title={n.detail}>
                                        {n.detail}
                                    </span>
                                )}
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                                {v != null && max > 0 && (
                                    <div
                                        className={cn('h-full rounded-full', i === hottest ? 'bg-primary' : 'bg-fg4')}
                                        style={{ width: `${Math.max(2, (v / max) * 100)}%` }}
                                    />
                                )}
                            </div>
                            <span
                                className={cn(figures, i === hottest ? 'text-foreground' : 'text-fg2')}
                                title={i === hottest ? 'Costs the most on its own' : undefined}
                            >
                                {v == null ? '—' : analyzed ? `${figure(v)} ms` : figure(v)}
                            </span>
                            <Rows node={n} />
                            {n.warnings.map((w) => (
                                <span
                                    key={w}
                                    className="col-span-full flex items-center gap-1.5 text-[11.5px] text-warning"
                                    style={indent(n.depth + (n.depth > 0 ? 1 : 0))}
                                >
                                    <TriangleAlert className="size-3 flex-none" aria-hidden />
                                    {w}
                                </span>
                            ))}
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

function PlanResult({ plan }: { plan: QueryPlan }) {
    const [raw, setRaw] = useState(false);
    const [copied, copy] = useCopy();
    const text = plan.engineText ?? plan.raw;
    return (
        <div className="flex h-full flex-col">
            <div className="flex h-9 flex-none items-center gap-2 border-b border-border-soft pr-2 pl-4 text-xs">
                <span className="min-w-0 truncate text-fg2">
                    {plan.analyzed ? 'Analyzed — the query ran' : 'Estimated plan — the query wasn’t run'}
                    {plan.engineText && <span className="text-fg4"> · read from the database’s text output, Raw has all of it</span>}
                </span>
                <Button variant="ghost" size="xs" className="ml-auto" aria-pressed={raw} onClick={() => setRaw(!raw)}>
                    Raw
                </Button>
                <Button variant="ghost" size="xs" onClick={() => copy(text)} aria-live="polite">
                    {copied ? 'Copied' : 'Copy'}
                </Button>
            </div>
            <div className="min-h-0 flex-1">
                {raw ? (
                    <pre className="h-full overflow-auto px-4 py-3 font-mono text-xs text-fg2 select-text">{text}</pre>
                ) : (
                    <PlanSteps plan={plan} />
                )}
            </div>
        </div>
    );
}

/** A query tab's or a table tab's plan; `empty` until it's explained */
function PlanView({ plan, empty }: { plan: Plan | null; empty: ReactNode }) {
    if (!plan) return empty;
    const { outcome, runningSince } = plan;
    if (!outcome) return <Running doing="Explaining" />;
    return (
        // Like results: the previous plan dims while a new one is worked out
        <div className={cn('h-full transition-opacity duration-200', runningSince !== null && 'opacity-50 delay-300')}>
            {outcome.ok ? <PlanResult plan={outcome.plan} /> : <Failed title="Explain failed" error={outcome.error} />}
        </div>
    );
}

function QueryPlanView() {
    const plan = useQuery((s) => currentQuery(s).plan);
    return <PlanView plan={plan} empty={<Empty text="Explain a query to see how the database runs it" keys={explainShortcut} does="explains" />} />;
}

const tab = 'flex-none px-0.5 text-[13px]';

/** The Results / Messages / Plan switcher of a query or table tab; `children` fill the rest of the row */
function PanelHeader({ children }: { children: ReactNode }) {
    return (
        <div className="relative flex h-10 flex-none items-center gap-4 border-b border-border-soft pr-4 text-xs text-fg3">
            <TabsList variant="line" className="h-full flex-none justify-start gap-4 rounded-none px-4 py-0">
                <TabsTrigger value="results" className={tab}>
                    Results
                </TabsTrigger>
                <TabsTrigger value="messages" className={tab}>
                    Messages
                </TabsTrigger>
                <TabsTrigger value="plan" className={tab}>
                    Plan
                </TabsTrigger>
            </TabsList>
            {children}
        </div>
    );
}

/**
 * Editing for a table tab: only a table (not a view) whose whole primary key is in the loaded
 * columns, so every UPDATE can name exactly one row, and only what the login's grants allow.
 * Otherwise `readOnly` says why. `fields` say how each column is edited, and whether it can be:
 * the grid and the Changes panel both read them
 */
export function useTableEditing(t: TableTab) {
    const { stageEdits, undoEdits, focusCell, openTable, addRows, deleteRows } = useQuery.getState();
    const engine = useConnections((s) => s.connections.find((c) => c.id === t.connectionId)?.kind);
    const details = useTableDetails(t);
    const columns = t.outcome?.ok ? t.outcome.output.columns : undefined;
    // Primary key columns by their index in the result
    const pk = useMemo(() => {
        if (!details || !columns || details.view) return undefined;
        const names = details.columns.filter((c) => c.key === 'PK').map((c) => c.name);
        const at = names.map((name) => columns.findIndex((c) => c.name === name));
        return names.length && !at.includes(-1) ? at.map((i, k) => [names[k], i] as const) : undefined;
    }, [details, columns]);
    const readOnly = !details
        ? undefined
        : details.view
          ? 'Read-only: a view'
          : !details.canInsert && !details.canUpdate && !details.canDelete
            ? 'Read-only: you don’t have permission to change this table'
            : !details.columns.some((c) => c.key === 'PK')
              ? 'Read-only: no primary key'
              : !pk
                ? 'Read-only: the primary key isn’t in the loaded columns'
                : undefined;
    const fields = useFields(columns, details, engine, t, readOnly);
    // Rows staged to be added, as grid rows of NULLs (their staged values show over them), each with its made-up key.
    // Rebuilt only when a row is added or dropped, so editing one doesn't reset the grid's selection
    const insertKeys = useMemo(
        () =>
            Object.keys(t.edits)
                .filter((k) => t.edits[k].op === 'insert')
                .join('\n'),
        [t.edits],
    );
    const added = useMemo(() => {
        const pks = new Map<(string | null)[], RowEdit['pk']>();
        // A new row's key is its made-up id under '' (see addRows)
        for (const k of insertKeys ? insertKeys.split('\n') : []) pks.set(Array<null>(columns?.length ?? 0).fill(null), [['', JSON.parse(k)[0]]]);
        return { rows: [...pks.keys()], pks };
    }, [insertKeys, columns]);

    if (!columns || !fields || !pk || !details || readOnly) return { engine, details, fields, editor: undefined, readOnly };

    const pkOf = (row: (string | null)[]) => {
        const id = added.pks.get(row);
        if (id) return id;
        const values = pk.map(([name, i]) => [name, row[i]] as const);
        return values.every(([, v]) => v !== null) ? (values as [string, string][]) : undefined;
    };
    const editor: Editor = {
        keyOf: (row) => {
            const values = pkOf(row);
            return values && rowKey(values);
        },
        edits: t.edits,
        field: (col) => fields[col],
        // The one place NOT NULL is kept: Delete, Set to NULL and pasting an empty cell all stage through here
        stage: (cells) => {
            const staged = cells.flatMap(({ row, col, to }) => {
                const values = pkOf(row);
                return values && (to !== null || fields[col].nullable) ? [{ pk: values, column: columns[col].name, from: row[col], to }] : [];
            });
            // Edits in a query's result go to its table's tab, opened behind the query on the first one
            if (useQuery.getState().tables.some((x) => x.id === t.id)) stageEdits(t.id, staged);
            else void openTable(t.connectionId, t.database, t.schema, t.table, undefined, false).then(() => stageEdits(t.id, staged));
        },
        undo: (redo) => undoEdits(t.id, redo),
        focus: t.focus,
        focused: () => focusCell(t.id, null),
        added: added.rows,
        locked: details.canUpdate ? undefined : 'Read-only: you don’t have permission to change existing rows',
        insert: details.canInsert ? () => addRows(t.id, [{}]) : undefined,
        // The key is left out, for the database to generate or for you to fill in
        duplicate: details.canInsert
            ? (rows) =>
                  addRows(
                      t.id,
                      rows.map((row) => Object.fromEntries(columns.flatMap((c, i) => (pk.some(([, at]) => at === i) ? [] : [[c.name, row[i]]])))),
                  )
            : undefined,
        remove: details.canDelete
            ? (rows, restore) =>
                  deleteRows(
                      t.id,
                      rows.flatMap((row) => {
                          const values = pkOf(row);
                          return values ? [values] : [];
                      }),
                      restore,
                  )
            : undefined,
    };
    return { engine, details, fields, editor, readOnly };
}

/** A table tab before its first rows: the grid's shape, a header and rows of placeholder cells */
function TableSkeleton({ name }: { name: string }) {
    const widths = ['w-10', 'w-24', 'w-16', 'w-28', 'w-14'];
    return (
        <div role="status" aria-label={`Loading ${name}…`} className="h-full overflow-hidden">
            <div className="flex h-8 items-center gap-8 border-b border-border-soft px-4">
                {widths.map((w) => (
                    <Skeleton key={w} className={cn(w, 'bg-fg4/25')} />
                ))}
            </div>
            {Array.from({ length: 12 }, (_, row) => (
                <div key={row} className="flex h-7 items-center gap-8 border-b border-border-soft/50 px-4">
                    {widths.map((w) => (
                        <Skeleton key={w} className={w} />
                    ))}
                </div>
            ))}
        </div>
    );
}

/** A table tab's whole body: a WHERE filter, the rows (sorted and filtered by the database), then its details. No editor */
export function TableResults({ tab: t }: { tab: TableTab }) {
    // Its own, not the query panel's: switching here leaves the query tabs where they were
    const [panel, setPanel] = useState<ResultsTab>('results');
    const explainTable = useQuery((s) => s.explainTable);
    const explain = (analyze: boolean) => {
        setPanel('plan');
        void explainTable(t.id, analyze);
    };
    const queryTable = useQuery((s) => s.queryTable);
    const openTable = useQuery((s) => s.openTable);
    const name = `${t.schema}.${t.table}`;
    const change = (c: Parameters<typeof queryTable>[1]) => void queryTable(t.id, c);

    // Its keys, for links to related rows (without them the grid just has no links), and whether it can be edited
    const { engine, details: known, editor, readOnly } = useTableEditing(t);
    // MySQL's schemas are its databases, as in the explorer
    const openRelated = (r: Related, filter: ColumnFilter) =>
        void openTable(t.connectionId, engine === 'mysql' ? r.schema : t.database, r.schema, r.table, [filter]);

    return (
        <Tabs
            value={panel}
            onValueChange={(v) => setPanel(v as ResultsTab)}
            aria-label={name}
            className="flex min-h-0 flex-1 flex-col gap-0 bg-surface"
        >
            <PanelHeader>
                <span className="h-4 w-px flex-none bg-border-soft" aria-hidden />
                {panel === 'plan' ? (
                    <span className="ml-auto flex flex-none items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => explain(false)} disabled={t.plan?.runningSince != null}>
                            Explain
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => explain(true)}
                            disabled={t.plan?.runningSince != null}
                            title="Runs the SELECT to measure it"
                        >
                            Explain analyze
                        </Button>
                    </span>
                ) : (
                    <>
                        <WhereBar tab={t} />
                        {editor?.insert && (
                            <Button variant="ghost" size="sm" onClick={editor.insert} title="Staged until you save" className="flex-none">
                                <Plus aria-hidden />
                                Add row
                            </Button>
                        )}
                    </>
                )}
                {t.runningSince !== null && (
                    <span role="status" className="flex flex-none items-baseline gap-2">
                        Loading…
                        <Elapsed since={t.runningSince} />
                    </span>
                )}
                {(t.runningSince !== null || t.plan?.runningSince != null) && <RunningBar />}
            </PanelHeader>
            <TabsContent value="messages" className="min-h-0">
                <MessagesView />
            </TabsContent>
            <TabsContent value="plan" className="min-h-0">
                <PlanView
                    plan={t.plan}
                    empty={
                        <div className="grid h-full place-content-center justify-items-center gap-3 text-fg3">
                            How the database reads this table, with its filter and order
                            <Button variant="outline" size="sm" onClick={() => explain(false)}>
                                Explain
                            </Button>
                        </div>
                    }
                />
            </TabsContent>
            <TabsContent value="results" className="min-h-0 flex-1">
                {t.outcome ? (
                    <div className={cn('h-full transition-opacity duration-200', t.runningSince !== null && 'opacity-50 delay-300')}>
                        <OutcomeView
                            outcome={t.outcome}
                            engine={engine}
                            // The database sorts and filters the whole table
                            table={{ schema: t.schema, name: t.table }}
                            sort={t.sort}
                            onSort={(sort) => change({ sort })}
                            filters={t.filters}
                            onFiltersChange={(filters) => change({ filters })}
                            details={known}
                            onOpenRelated={openRelated}
                            editor={editor}
                        />
                    </div>
                ) : (
                    <TableSkeleton name={name} />
                )}
            </TabsContent>
            <TableStatusBar tab={t} onChange={change} readOnly={readOnly} />
        </Tabs>
    );
}

/** A query result's footer: the tab's connection and database, the rows, and the grid's sort and filters */
function QueryStatusBar({ at, shape, setShape }: Omit<ResultSetProps, 'setAt'>) {
    // Field by field, not the whole tab: the tab object changes on every keystroke in the editor
    const connectionId = useQuery((s) => currentQuery(s).connectionId);
    const picked = useQuery((s) => currentQuery(s).database);
    // The shown result set's counts and statement, not always the last statement's
    const { shown: last, statement } = useShownSet(at);
    const running = useQuery((s) => currentQuery(s).runningSince !== null);
    const loadAllRows = useQuery((s) => s.loadAllRows);
    const connection = useConnections((s) => activeConnection(s.connections, connectionId));
    const output = last?.ok ? last.output : null;
    const shown = useMemo(
        () =>
            output && shape.filters.length
                ? filterRows(
                      output.rows,
                      output.columns.map((c) => c.name),
                      shape.filters,
                  ).length
                : undefined,
        [output, shape.filters],
    );
    const database = connection && activeDatabase(connection, { connectionId, database: picked });
    return (
        <StatusBar
            label="Result details"
            connectionId={connection?.id}
            location={database || undefined}
            locationTitle={database ? `Database: ${database}` : undefined}
            outcome={last}
            loading={running && !last}
            shown={shown}
            extra={
                output?.truncated &&
                (statement && rerunnable(statement) ? (
                    <LoadAllButton total={output.capped ? null : output.rowsAffected} onClick={() => void loadAllRows(at)} />
                ) : (
                    // Running it again would repeat what it changed
                    <span
                        className="px-2 text-fg4"
                        title="Only a single read statement (SELECT, WITH, SHOW…) can be run again for all its rows. Add LIMIT and OFFSET to page through it."
                    >
                        first {output.rows.length.toLocaleString()} kept
                    </span>
                ))
            }
            chips={shapeChips(shape, setShape)}
        />
    );
}

export function ResultsPanel() {
    const running = useQuery((s) => currentQuery(s).runningSince !== null || currentQuery(s).plan?.runningSince != null);
    const lastRun = useQuery((s) => currentQuery(s).lastRun);
    const resultsTab = useUi((s) => s.resultsTab);
    const setResultsTab = useUi((s) => s.setResultsTab);
    const [at, setAt] = useResultSet(lastRun);
    const [shape, setShape] = useShape(lastRun, at);
    return (
        <Tabs value={resultsTab} onValueChange={(v) => setResultsTab(v as ResultsTab)} className="h-full gap-0 bg-surface">
            <PanelHeader>
                <div className="ml-auto min-w-0 truncate">
                    <Status />
                </div>
                {running && <RunningBar />}
            </PanelHeader>
            <TabsContent value="results" className="min-h-0">
                <ResultsView at={at} setAt={setAt} shape={shape} setShape={setShape} />
            </TabsContent>
            <TabsContent value="messages" className="min-h-0">
                <MessagesView />
            </TabsContent>
            <TabsContent value="plan" className="min-h-0">
                <QueryPlanView />
            </TabsContent>
            <QueryStatusBar at={at} shape={shape} setShape={setShape} />
        </Tabs>
    );
}
