import { memo, useDeferredValue, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, CircleAlert, CircleSlash, Pencil, Search, Undo2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { EngineLogo } from '@/components/shell/engine-logos';
import { useConnections } from '@/stores/connections';
import { editCount, totalEdits, useQuery, type RowEdit, type TableTab } from '@/stores/query';
import { useUi } from '@/stores/ui';
import { useEnter } from '@/lib/spring';
import { cn, count, saveShortcut } from '@/lib/utils';
import { CellEditor, NullMark, type CellField } from './CellEditor';
import { useTableEditing } from './ResultsPanel';

const icon =
    'grid size-6 flex-none place-items-center rounded text-fg3 outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50';
// Hidden until the change is hovered or holds focus, so a keyboard user still reaches every action
const reveal = 'opacity-0 transition-opacity group-hover/change:opacity-100 group-focus-within/change:opacity-100 [@media(hover:none)]:opacity-100';

// Rows listed per table; a fill down a big table can stage thousands, and each row is several elements
const SHOWN_ROWS = 200;
// Below this many changes the list is short enough to scan without a filter
const FILTER_AT = 20;
// Up to this many rows slide in one by one; a bigger section only slides in as a whole
const ANIMATED_ROWS = 20;

type Cell = NonNullable<TableTab['focus']>;
type Columns = Map<string, CellField | undefined>;

/** Shows a table tab, with one cell selected in its grid when `cell` is given */
function showTab(id: string, cell?: Cell) {
    useQuery.getState().focusCell(id, cell ?? null);
    // The audit log takes the workspace's place
    const ui = useUi.getState();
    if (ui.view === 'audit') ui.setView('workspace');
}

/** A cell value as the grid shows it: NULL is a marker, not text */
function Value({ value }: { value: string | null }) {
    if (value === null) return <NullMark />;
    if (value === '') return <span className="text-fg4">empty</span>;
    return <>{value}</>;
}

/** Discarding can't be undone, so it asks first */
function DiscardButton({
    label,
    title,
    description,
    disabled,
    onConfirm,
}: {
    label: string;
    title: string;
    description: string;
    disabled: boolean;
    onConfirm: () => void;
}) {
    return (
        <AlertDialog>
            <AlertDialogTrigger asChild>
                <Button variant="ghost" size="xs" disabled={disabled} aria-label={title.replace(/\?$/, '')}>
                    {label}
                </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    <AlertDialogDescription>{description}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Keep editing</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={onConfirm}>
                        Discard changes
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

/** One changed column: its name, the loaded value struck through, the staged one below it */
function ChangeLine({
    tabId,
    rowKey,
    row,
    column,
    field,
    disabled,
}: {
    tabId: string;
    rowKey: string;
    row: RowEdit;
    column: string;
    field: CellField | undefined;
    disabled: boolean;
}) {
    const [editing, setEditing] = useState(false);
    const { from, to } = row.changes[column];
    // Staging a cell's loaded value takes its change back
    const set = (value: string | null) => useQuery.getState().stageEdits(tabId, [{ pk: row.pk, column, from, to: value }]);
    const canEdit = !!field && !field.readOnly && !disabled;

    return (
        <li className="group/change grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_auto] items-start gap-x-2 py-1">
            <button
                type="button"
                onClick={() => showTab(tabId, { row: rowKey, column })}
                title={`Show ${column} in the grid`}
                className="truncate rounded text-left font-mono text-[11px] leading-5 text-fg3 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
                {column}
            </button>
            <div className="min-w-0 text-xs leading-5">
                <del title={from ?? 'NULL'} className="block truncate text-fg4 decoration-fg4/70">
                    <span className="sr-only">was </span>
                    <Value value={from} />
                </del>
                {editing && field ? (
                    <CellEditor
                        value={to}
                        field={field}
                        onDone={(value) => {
                            setEditing(false);
                            if (value !== undefined) set(value);
                        }}
                        className="h-5 w-full min-w-0 rounded bg-elev px-1 text-foreground ring-1 ring-primary outline-none"
                    />
                ) : (
                    <ins className="flex min-w-0 items-center gap-1.5 text-foreground no-underline">
                        {/* The grid's staged-cell dot, so the two read as the same thing */}
                        <span aria-hidden className="size-1.5 flex-none rounded-full bg-warning" />
                        <span className="sr-only">now </span>
                        <button
                            type="button"
                            disabled={!canEdit}
                            onClick={() => setEditing(true)}
                            title={to ?? 'NULL'}
                            className="min-w-0 truncate rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 enabled:hover:bg-hover"
                        >
                            <Value value={to} />
                        </button>
                    </ins>
                )}
            </div>
            <div className={cn('flex items-center', reveal)}>
                {canEdit && (
                    <button type="button" onClick={() => setEditing(true)} aria-label={`Edit ${column}`} title="Edit" className={icon}>
                        <Pencil className="size-3.5" aria-hidden />
                    </button>
                )}
                {canEdit && to !== null && field.nullable && (
                    <button type="button" onClick={() => set(null)} aria-label={`Set ${column} to NULL`} title="Set to NULL" className={icon}>
                        <CircleSlash className="size-3.5" aria-hidden />
                    </button>
                )}
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => set(from)}
                    aria-label={`Revert ${column}`}
                    title={`Revert ${column}`}
                    className={cn(icon, 'disabled:opacity-40')}
                >
                    <Undo2 className="size-3.5" aria-hidden />
                </button>
            </div>
        </li>
    );
}

/** One row's changes, under its primary key. Unchanged rows keep their objects, so memo skips them */
const RowCard = memo(function RowCard({
    tabId,
    rowKey,
    row,
    only,
    fields,
    disabled,
    still,
}: {
    tabId: string;
    rowKey: string;
    row: RowEdit;
    /** The columns a filter matched; all of them when undefined */
    only: string[] | undefined;
    fields: Columns;
    disabled: boolean;
    /** Arrives without sliding in (read on mount) */
    still: boolean;
}) {
    const ref = useRef<HTMLLIElement>(null);
    useEnter(ref, { x: 8, skip: still });
    const columns = only ?? Object.keys(row.changes);
    const key = row.pk.map(([c, v]) => `${c} ${v}`).join(' · ');
    const revertRow = () =>
        useQuery.getState().stageEdits(
            tabId,
            Object.entries(row.changes).map(([column, { from }]) => ({ pk: row.pk, column, from, to: from })),
        );

    return (
        <li ref={ref} className="border-t border-border-soft px-3 py-2">
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => showTab(tabId, { row: rowKey, column: columns[0] })}
                    title="Show this row in the grid"
                    className="min-w-0 truncate rounded font-mono text-[11px] text-fg2 tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                    {key}
                </button>
                <button
                    type="button"
                    disabled={disabled}
                    onClick={revertRow}
                    aria-label={`Revert every change to ${key}`}
                    title="Revert this row"
                    className={cn(icon, 'ml-auto disabled:opacity-40')}
                >
                    <Undo2 className="size-3.5" aria-hidden />
                </button>
            </div>
            <ul>
                {columns.map((column) => (
                    <ChangeLine key={column} tabId={tabId} rowKey={rowKey} row={row} column={column} field={fields.get(column)} disabled={disabled} />
                ))}
            </ul>
        </li>
    );
});

type Shown = { key: string; row: RowEdit; only?: string[] };

/** The rows (and within them, the columns) a lowercased filter matches; every row when it's empty */
function matching(tab: TableTab, q: string): Shown[] {
    const rows = Object.entries(tab.edits);
    if (!q || tab.table.toLowerCase().includes(q)) return rows.map(([key, row]) => ({ key, row }));
    const has = (v: string | null) => v !== null && v.toLowerCase().includes(q);
    return rows.flatMap(([key, row]) => {
        const only = Object.entries(row.changes)
            .filter(([column, { from, to }]) => has(column) || has(from) || has(to))
            .map(([column]) => column);
        const pk = row.pk.some(([, v]) => has(v));
        return pk ? [{ key, row }] : only.length ? [{ key, row, only }] : [];
    });
}

/** One table tab's staged edits, row by row, with its own Save and Discard */
function TableChanges({ tab, shown, busy, filtering }: { tab: TableTab; shown: Shown[]; busy: boolean; filtering: boolean }) {
    const ref = useRef<HTMLElement>(null);
    useEnter(ref, { x: 8 });
    const listId = useId();
    const [collapsed, setCollapsed] = useState(false);
    const open = filtering || !collapsed;
    const connection = useConnections((s) => s.connections.find((c) => c.id === tab.connectionId));
    const { fields } = useTableEditing(tab);
    const columns = tab.outcome?.ok ? tab.outcome.output.columns : undefined;
    const byName: Columns = useMemo(() => new Map(columns?.map((c, i) => [c.name, fields?.[i]])), [columns, fields]);
    const n = editCount(tab);
    const disabled = busy || tab.saving;
    // MySQL's schema is its database: name it once
    const where = [tab.database !== tab.schema && tab.database, tab.schema, connection?.label].filter(Boolean).join(' · ');

    return (
        <section ref={ref} aria-label={`Changes to ${tab.table}`} className="border-b border-border-soft">
            <header className="flex items-center gap-1 py-2 pr-2 pl-2">
                <button
                    type="button"
                    onClick={() => setCollapsed(!collapsed)}
                    disabled={filtering}
                    aria-expanded={open}
                    aria-controls={listId}
                    aria-label={`${open ? 'Collapse' : 'Expand'} ${tab.table}`}
                    className={cn(icon, 'disabled:opacity-40')}
                >
                    <ChevronRight className={cn('size-3.5 transition-transform ease-spring', open && 'rotate-90')} aria-hidden />
                </button>
                <button
                    type="button"
                    onClick={() => showTab(tab.id)}
                    title={`Show ${tab.schema}.${tab.table}`}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                    {connection && <EngineLogo id={connection.kind} className="size-4 flex-none" />}
                    <span className="min-w-0">
                        <span className="flex items-baseline gap-1.5">
                            <span className="truncate text-[13px] font-medium">{tab.table}</span>
                            <span className="flex-none font-mono text-[11px] text-fg4 tabular-nums">{n.toLocaleString()}</span>
                        </span>
                        <span className="block truncate text-[11px] text-fg3">{where}</span>
                    </span>
                </button>
                <DiscardButton
                    label="Discard"
                    title={`Discard ${count(n, 'change')} to ${tab.table}?`}
                    description={`The edits you haven’t saved to ${tab.table} are thrown away. The database isn’t touched.`}
                    disabled={disabled}
                    onConfirm={() => useQuery.getState().discardEdits(tab.id)}
                />
                {/* Secondary: Save all in the footer is the panel's one accent */}
                <Button
                    size="xs"
                    variant="secondary"
                    disabled={disabled}
                    onClick={() => void useQuery.getState().saveEdits(tab.id)}
                    aria-label={`Save ${count(n, 'change')} to ${tab.table}`}
                >
                    {tab.saving ? 'Saving…' : 'Save'}
                </Button>
            </header>

            {tab.editsError && (
                <div role="alert" className="mx-3 mb-2 flex gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs">
                    <CircleAlert className="mt-0.5 size-3.5 flex-none text-danger" aria-hidden />
                    <div className="min-w-0">
                        <p className="text-foreground wrap-anywhere">{tab.editsError}</p>
                        <p className="mt-1 text-fg3">Nothing was written and your changes are still here. Fix them, then save again.</p>
                    </div>
                </div>
            )}

            {open && (
                <ol id={listId}>
                    {shown.slice(0, SHOWN_ROWS).map(({ key, row, only }) => (
                        <RowCard
                            key={key}
                            tabId={tab.id}
                            rowKey={key}
                            row={row}
                            only={only}
                            fields={byName}
                            disabled={disabled}
                            still={shown.length > ANIMATED_ROWS}
                        />
                    ))}
                    {shown.length > SHOWN_ROWS && (
                        <li className="border-t border-border-soft px-3 py-2 text-xs text-fg3">
                            and {count(shown.length - SHOWN_ROWS, 'more row')}, saved or discarded with the rest
                        </li>
                    )}
                </ol>
            )}
        </section>
    );
}

type Report = { results: { name: string; error: string | null }[]; edits: TableTab['edits'][] };

/** Every table tab's unsaved edits, grouped by table in tab order. Takes the inspector's place on the right */
export function ChangesPanel() {
    // Same tab objects until a table changes, so typing in the editor doesn't re-render this
    const tabs = useQuery(useShallow((s) => s.tables.filter((t) => editCount(t) > 0)));
    const setChangesOpen = useUi((s) => s.setChangesOpen);
    const [saving, setSaving] = useState<{ name: string; at: number; of: number } | null>(null);
    const [report, setReport] = useState<Report | null>(null);
    const [filter, setFilter] = useState('');
    const q = useDeferredValue(filter.trim().toLowerCase());
    const total = totalEdits({ tables: tabs });
    const filtering = total >= FILTER_AT && q !== '';
    const sections = useMemo(
        () => tabs.map((tab) => ({ tab, shown: matching(tab, filtering ? q : '') })).filter((s) => s.shown.length),
        [tabs, q, filtering],
    );
    // The last Save all's results stay up until any change is staged, reverted or saved after it
    const results = report && report.edits.length === tabs.length && tabs.every((t, i) => t.edits === report.edits[i]) ? report.results : null;

    // Tables on different connections can't share a transaction, so each saves on its own; a failure keeps its edits and the rest go on
    async function saveAll() {
        const out: Report['results'] = [];
        setReport(null);
        for (const [i, t] of tabs.entries()) {
            setSaving({ name: t.table, at: i + 1, of: tabs.length });
            const ok = await useQuery.getState().saveEdits(t.id);
            out.push({ name: t.table, error: ok ? null : (useQuery.getState().tables.find((x) => x.id === t.id)?.editsError ?? 'Not saved') });
        }
        setSaving(null);
        const left = useQuery.getState().tables.filter((t) => editCount(t) > 0);
        setReport({ results: out, edits: left.map((t) => t.edits) });
    }

    return (
        <aside aria-label="Unsaved changes" className="flex h-full flex-col bg-panel">
            <header className="flex h-10 flex-none items-center gap-2 border-b border-border-soft pr-2 pl-3.5">
                <h2 className="font-semibold">Changes</h2>
                {total > 0 && (
                    <span className="truncate text-xs text-fg3 tabular-nums">
                        {count(total, 'change')} in {count(tabs.length, 'table')}
                    </span>
                )}
                <button
                    type="button"
                    onClick={() => setChangesOpen(false)}
                    aria-label="Close changes panel"
                    title="Close"
                    className={cn(icon, 'ml-auto')}
                >
                    <X className="size-3.5" aria-hidden />
                </button>
            </header>

            {total >= FILTER_AT && (
                <div className="flex-none border-b border-border-soft p-2">
                    <label className="flex h-7 items-center gap-2 rounded-md bg-elev px-2 text-xs ring-1 ring-border-soft focus-within:ring-2 focus-within:ring-ring/50">
                        <Search className="size-3.5 flex-none text-fg4" aria-hidden />
                        <input
                            type="search"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            onKeyDown={(e) => {
                                // Escape clears the filter first, before anything outside hears it
                                if (e.key !== 'Escape' || !filter) return;
                                e.stopPropagation();
                                setFilter('');
                            }}
                            placeholder="Filter by table, column or value…"
                            aria-label="Filter changes"
                            spellCheck={false}
                            autoComplete="off"
                            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-fg4"
                        />
                    </label>
                </div>
            )}

            <div className="min-h-0 flex-1 overflow-auto">
                {tabs.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-xs">
                        <p className="text-[13px] text-fg2">No unsaved changes</p>
                        <p className="max-w-60 text-pretty text-fg3">
                            Double-click a cell in a table to edit it, or paste and drag the fill handle over a range. Edits wait here until you save
                            them.
                        </p>
                        <p className="mt-2 flex items-center gap-1.5 text-fg4">
                            <Kbd>{saveShortcut}</Kbd> on a table tab opens this panel
                        </p>
                    </div>
                ) : sections.length === 0 ? (
                    <p className="px-4 py-8 text-center text-xs text-fg3">No changes match “{filter.trim()}”</p>
                ) : (
                    sections.map(({ tab, shown }) => (
                        <TableChanges key={tab.id} tab={tab} shown={shown} busy={saving !== null} filtering={filtering} />
                    ))
                )}
            </div>

            {(total > 0 || results) && (
                <footer className="flex flex-none flex-col gap-2 border-t border-border-soft p-3">
                    <div aria-live="polite" className="empty:hidden">
                        {saving ? (
                            <p className="text-xs text-fg3">
                                Saving {saving.name}
                                {saving.of > 1 && `, ${saving.at} of ${saving.of}`}…
                            </p>
                        ) : (
                            results && (
                                <ul className="flex flex-col gap-1 text-xs">
                                    {results.map(({ name, error }, i) => (
                                        <li key={i} className="flex items-start gap-1.5">
                                            {error ? (
                                                <CircleAlert className="mt-0.5 size-3.5 flex-none text-danger" aria-hidden />
                                            ) : (
                                                <Check className="mt-0.5 size-3.5 flex-none text-success" aria-hidden />
                                            )}
                                            <span className="min-w-0 wrap-anywhere">
                                                <span className="text-fg2">{name}</span>{' '}
                                                <span className={error ? 'text-danger' : 'text-fg3'}>{error ? `not saved: ${error}` : 'saved'}</span>
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )
                        )}
                    </div>
                    {total > 0 && (
                        <div className="flex items-center gap-2">
                            <p className="min-w-0 flex-1 text-[11px] text-fg4">Each table saves in its own transaction</p>
                            <DiscardButton
                                label="Discard all"
                                title={`Discard all ${count(total, 'change')}?`}
                                description={`The edits you haven’t saved to ${count(tabs.length, 'table')} are thrown away. The database isn’t touched.`}
                                disabled={saving !== null}
                                onConfirm={() => {
                                    const { discardEdits } = useQuery.getState();
                                    tabs.forEach((t) => discardEdits(t.id));
                                    setReport(null);
                                }}
                            />
                            <Button size="sm" disabled={saving !== null} onClick={() => void saveAll()}>
                                {saving ? 'Saving…' : `Save all ${count(total, 'change')}`}
                            </Button>
                        </div>
                    )}
                </footer>
            )}
        </aside>
    );
}
