import { useState, type ComponentProps, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, CircleAlert, Filter, ListFilter, Lock, X, type LucideIcon } from 'lucide-react';
import { commands } from '@/bindings';
import { StatusDot } from '@/components/shell/StatusDot';
import { engineName } from '@/lib/engines';
import { describeFilter, type ColumnFilter } from '@/lib/column-filter';
import { cn, count, saveShortcut } from '@/lib/utils';
import { errorMessage, useConnections } from '@/stores/connections';
import { useUi } from '@/stores/ui';
import { ALL_ROWS, editCount, qualifiedName, ROW_CAP, whereClause, type Outcome, type Sort, type TableTab } from '@/stores/query';

// Segments keep their text on one line and never shrink; only the ones marked `fluid` give way, with an ellipsis
const segment = 'flex h-full flex-none items-center gap-1.5 px-2 whitespace-nowrap';
const fluid = 'min-w-0 flex-initial';
const button = cn(
    segment,
    'outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
);

/** A clickable footer segment, e.g. "Count rows" or "Load all rows" */
export function StatusButton({ className, ...props }: ComponentProps<'button'>) {
    return <button type="button" className={cn(button, className)} {...props} />;
}

/** "Load all 3,256 rows": runs again keeping every row, up to ALL_ROWS */
export function LoadAllButton({ total, onClick }: { total: number | null; onClick: () => void }) {
    const label =
        total === null ? 'Load all rows' : total > ALL_ROWS ? `Load first ${ALL_ROWS.toLocaleString()}` : `Load all ${total.toLocaleString()} rows`;
    return (
        <StatusButton onClick={onClick} className="text-primary-text" title={`Runs it again keeping up to ${ALL_ROWS.toLocaleString()} rows`}>
            {label}
        </StatusButton>
    );
}

/** Something shaping the rows (a filter, the sort), shown with a button that removes it */
export type Chip = { key: string; icon: LucideIcon; text: ReactNode; title: string; clearLabel: string; onClear: () => void };

/** What shapes a result's rows in the grid */
export type Shape = { sort: Sort | null; filters: ColumnFilter[] };

/** Chips for a sort and column filters; clearing one calls `change` with the sort, or the filters without it */
export function shapeChips({ sort, filters }: Shape, change: (change: Partial<Shape>) => void): Chip[] {
    return [
        ...filters.map((f) => ({
            key: `filter:${f.column}`,
            icon: ListFilter,
            text: <span className="font-mono">{describeFilter(f)}</span>,
            title: describeFilter(f),
            clearLabel: `Clear filter on ${f.column}`,
            onClear: () => change({ filters: filters.filter((x) => x !== f) }),
        })),
        ...(sort
            ? [
                  {
                      key: 'sort',
                      icon: sort.desc ? ArrowDown : ArrowUp,
                      text: (
                          <>
                              Sorted by <span className="font-mono text-fg2">{sort.column}</span>
                              <span className="sr-only">{sort.desc ? ', descending' : ', ascending'}</span>
                          </>
                      ),
                      title: `Sorted by ${sort.column}, ${sort.desc ? 'descending' : 'ascending'}`,
                      clearLabel: 'Clear sort',
                      onClear: () => change({ sort: null }),
                  },
              ]
            : []),
    ];
}

type Props = {
    label: string;
    connectionId: string | undefined;
    /** Where the rows come from: `database › schema › table`, or the database a query ran in */
    location?: ReactNode;
    locationTitle?: string;
    outcome: Outcome | null;
    loading: boolean;
    /** Rows left after filtering the loaded ones in the grid, when that's fewer */
    shown?: number;
    /** Extra segment after the counts, e.g. the table tab's "Count rows" */
    extra?: ReactNode;
    chips: Chip[];
};

/** VS Code–style footer under a result: where the rows come from, how many, and what shapes them */
export function StatusBar({ label, connectionId, location, locationTitle, outcome, loading, shown, extra, chips }: Props) {
    const connection = useConnections((s) => s.connections.find((c) => c.id === connectionId));
    const output = outcome?.ok ? outcome.output : null;
    const loaded = output?.rows.length ?? 0;

    return (
        <footer
            aria-label={label}
            // A container: when the panel is narrow, the least useful segments drop out instead of wrapping
            className="@container flex h-6 flex-none items-center justify-between gap-2 overflow-hidden border-t border-border-soft bg-surface text-[11px] text-fg3"
        >
            <div className="flex h-full min-w-0 items-center">
                <span className={cn(segment, fluid)} title={connection ? `${connection.label} · ${engineName[connection.kind]}` : 'Disconnected'}>
                    <StatusDot state={connection ? 'open' : 'closed'} />
                    <span className="truncate text-fg2">{connection?.label ?? 'Disconnected'}</span>
                    {connection && <span className="hidden text-fg4 @3xl:inline">{engineName[connection.kind]}</span>}
                </span>
                {location && (
                    <span className={cn(segment, fluid, 'font-mono')} title={locationTitle}>
                        <span className="truncate">{location}</span>
                    </span>
                )}
                {loading ? (
                    <span className={segment}>Loading…</span>
                ) : (
                    output &&
                    output.columns.length > 0 && (
                        <>
                            <span className={cn(segment, 'tabular-nums')}>
                                {shown !== undefined && shown < loaded ? (
                                    <>
                                        {count(shown, 'row')} <span className="text-fg4">of {loaded.toLocaleString()} loaded</span>
                                    </>
                                ) : output.truncated ? (
                                    // The driver counted every row while only the first ones were kept
                                    <>
                                        {loaded.toLocaleString()} <span className="text-fg4">of {count(output.rowsAffected, 'row')}</span>
                                    </>
                                ) : (
                                    count(loaded, 'row')
                                )}
                            </span>
                            <span className={cn(segment, 'hidden tabular-nums @2xl:flex')}>{count(output.columns.length, 'column')}</span>
                            {extra}
                        </>
                    )
                )}
            </div>
            <div className="flex h-full min-w-0 items-center">
                {chips.map(({ key, icon: Icon, text, title, clearLabel, onClear }) => (
                    <span key={key} className={cn(segment, 'pr-0.5')} title={title}>
                        <Icon aria-hidden className="size-3 flex-none" />
                        <span className="max-w-60 truncate">{text}</span>
                        <button
                            type="button"
                            aria-label={clearLabel}
                            title={clearLabel}
                            onClick={onClear}
                            className="grid size-4 flex-none place-items-center rounded text-fg4 outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                        >
                            <X className="size-3" />
                        </button>
                    </span>
                ))}
                {outcome && !outcome.ok && (
                    <span className={cn(segment, 'text-danger')} title={outcome.error}>
                        <CircleAlert aria-hidden className="size-3 flex-none" />
                        Query failed
                    </span>
                )}
                {output && <span className={cn(segment, 'font-mono tabular-nums')}>{output.elapsedMs.toLocaleString()}&nbsp;ms</span>}
            </div>
        </footer>
    );
}

type Total = { state: 'counting' } | { state: 'done'; rows: number } | { state: 'failed'; error: string };

/** The table tab's footer: its path, a "Count rows" on demand, unsaved edits or why it can't be edited, and its WHERE, column filters and sort */
export function TableStatusBar({
    tab,
    onChange,
    readOnly,
}: {
    tab: TableTab;
    onChange: (change: Partial<Pick<TableTab, 'where' | 'sort' | 'filters' | 'all'>>) => void;
    /** Why its rows can't be edited, when they can't */
    readOnly?: string;
}) {
    const changesOpen = useUi((s) => s.changesOpen);
    const setChangesOpen = useUi((s) => s.setChangesOpen);
    const edits = editCount(tab);
    const kind = useConnections((s) => s.connections.find((c) => c.id === tab.connectionId)?.kind);
    // Tagged with the outcome it counted for, so a reload, a new filter or another tab drops it without an effect
    const [total, setTotal] = useState<{ for: Outcome | null; total: Total } | null>(null);
    const current = total?.for === tab.outcome ? total.total : null;

    async function countRows() {
        if (!kind) return;
        const at = tab.outcome;
        const sql = `SELECT COUNT(*) FROM ${qualifiedName(kind, tab.schema, tab.table)}${whereClause(kind, tab.where, tab.filters)}`;
        setTotal({ for: at, total: { state: 'counting' } });
        try {
            const { rows } = await commands.runQuery(tab.connectionId, sql, tab.database, false);
            setTotal({ for: at, total: { state: 'done', rows: Number(rows[0]?.[0] ?? 0) } });
        } catch (error) {
            setTotal({ for: at, total: { state: 'failed', error: errorMessage(error) } });
        }
    }

    const where: Chip[] = tab.where
        ? [
              {
                  key: 'where',
                  icon: Filter,
                  text: <span className="font-mono">{tab.where}</span>,
                  title: tab.where,
                  clearLabel: 'Clear WHERE',
                  onClear: () => onChange({ where: '' }),
              },
          ]
        : [];

    return (
        <StatusBar
            label="Table details"
            connectionId={tab.connectionId}
            location={
                <>
                    {/* MySQL's schema is its database: name it once */}
                    {tab.database !== tab.schema && (
                        <>
                            {tab.database} <span className="text-fg4">›</span>{' '}
                        </>
                    )}
                    {tab.schema} <span className="text-fg4">›</span> <span className="text-fg2">{tab.table}</span>
                </>
            }
            locationTitle={tab.database !== tab.schema ? `${tab.database}.${tab.schema}.${tab.table}` : `${tab.schema}.${tab.table}`}
            outcome={tab.outcome}
            loading={tab.runningSince !== null}
            extra={
                <>
                    {/* The first ROW_CAP rows came back: there may be more */}
                    {!tab.all && tab.outcome?.ok && tab.outcome.output.rows.length >= ROW_CAP && (
                        <LoadAllButton total={current?.state === 'done' ? current.rows : null} onClick={() => onChange({ all: true })} />
                    )}
                    {current?.state === 'done' ? (
                        <span className={cn(segment, 'tabular-nums')}>of {current.rows.toLocaleString()} total</span>
                    ) : current?.state === 'counting' ? (
                        <span className={segment}>Counting…</span>
                    ) : (
                        <StatusButton
                            onClick={countRows}
                            disabled={!kind}
                            aria-label={current ? `Counting rows failed: ${current.error}. Try again` : 'Count all rows in the table'}
                            title={current ? current.error : 'Runs COUNT(*), which can be slow on large tables'}
                            className={cn(current && 'text-danger')}
                        >
                            {current ? 'Count failed' : 'Count rows'}
                        </StatusButton>
                    )}
                    {edits > 0 && (
                        <StatusButton
                            onClick={() => setChangesOpen(!changesOpen)}
                            aria-expanded={changesOpen}
                            className="font-medium text-primary-text hover:bg-primary-soft hover:text-primary-text"
                            title={`Review the changes to save or discard (${saveShortcut})`}
                        >
                            <span aria-hidden className="size-1.5 rounded-full bg-warning" />
                            {count(edits, 'unsaved change')}
                            <span className="font-normal text-fg4">{saveShortcut}</span>
                        </StatusButton>
                    )}
                    {/* The panel shows it itself when open */}
                    {tab.editsError && !changesOpen && (
                        <span role="alert" className={cn(segment, fluid, 'text-danger')} title={tab.editsError}>
                            <CircleAlert aria-hidden className="size-3 flex-none" />
                            <span className="truncate">{tab.editsError}</span>
                        </span>
                    )}
                    {readOnly && (
                        <span className={cn(segment, 'text-fg4')} title={readOnly}>
                            <Lock aria-hidden className="size-3 flex-none" />
                            {readOnly}
                        </span>
                    )}
                </>
            }
            chips={[...where, ...shapeChips(tab, onChange)]}
        />
    );
}
