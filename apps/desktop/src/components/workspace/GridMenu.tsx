import {
    ArrowDown,
    ArrowDownLeft,
    ArrowUp,
    ArrowUpRight,
    CalendarRange,
    ArrowDownToLine,
    ChevronsLeftRight,
    ClipboardCopy,
    ClipboardPaste,
    Copy,
    Filter,
    FilterX,
    ListFilter,
    PanelRightOpen,
    Pencil,
    Plus,
    SquareDashed,
    Trash2,
    Undo2,
    X,
} from 'lucide-react';
import type { IncomingRef, ResultColumn } from '@/bindings';
import {
    ContextMenuContent,
    ContextMenuDestructiveItem,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuShortcut,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import { describeFilter, filterKindOf, type ColumnFilter, type FilterOp } from '@/lib/column-filter';
import { sqlName } from '@/lib/columns';
import type { Connection } from '@/stores/connections';
import type { Sort } from '@/stores/query';
import { sqlValue } from '@/lib/sql-quote';
import type { Related } from '@/lib/table-details';
import { isMac, shortcutLabel } from '@/lib/utils';

const copyKeys = shortcutLabel('Ctrl+C');
const pasteKeys = shortcutLabel('Ctrl+V');
const selectAllKeys = shortcutLabel('Ctrl+A');
const deleteKey = isMac ? '⌫' : 'Delete';
export const openClick = isMac ? '⌘-click' : 'Ctrl-click';

/** Long values shortened for a menu label or hint */
export const short = (value: string | null) => (value === null ? 'NULL' : value.length > 24 ? `${value.slice(0, 24)}…` : value || '(empty)');

type Props = {
    column: ResultColumn;
    /** The right-clicked cell, or undefined on the header; its row copies as shown, staged values included */
    cell?: { value: string | null; onCopyRowJson: () => void; onCopyRowTsv: () => void };
    engine: Connection['kind'] | undefined;
    /** Where this column's foreign key points, if it has one */
    reference?: Related;
    /** Foreign keys in other tables that point at this column */
    referencedBy?: IncomingRef[];
    onOpenRelated: (target: Related, value: string) => void;
    sort: Sort | null;
    filters: ColumnFilter[];
    onSort: (sort: Sort | null) => void;
    setFilter: (column: string, filter: ColumnFilter | null) => void;
    onClearFilters: () => void;
    onEditFilter: (column: string) => void;
    onShowValue: () => void;
    copy: (text: string | null) => void;
    /** A selection of several cells, which Copy, Set to NULL, Revert and Paste act on */
    range?: { cells: number; onCopy: () => void };
    /** When the cell can be edited: edit it, stage NULL (unless NOT NULL), paste, fill down a range, and, with changes there, take them back */
    edit?: { onEdit: () => void; onSetNull?: () => void; onRevert?: () => void; onPaste: () => void; onFillDown?: () => void };
};

/**
 * The grid's right-click menu. On a cell: its value (show, copy, copy as SQL), filters built from it,
 * then the column's sort and filter. On a header: just the column's. Most-used first, shortcuts shown.
 */
export function GridMenu({
    column,
    cell,
    engine,
    reference,
    referencedBy,
    onOpenRelated,
    sort,
    filters,
    onSort,
    setFilter,
    onClearFilters,
    onEditFilter,
    onShowValue,
    copy,
    range,
    edit,
}: Props) {
    const name = column.name;
    const kind = filterKindOf(column.kind, column.typeName);
    const quoted = engine ? sqlName(engine, name) : name;
    const current = filters.find((f) => f.column === name);
    const by = (op: FilterOp, value?: string) => setFilter(name, { column: name, kind, op, ...(value !== undefined && { value }) });
    const value = cell?.value;
    const numeric = column.kind === 'number';
    const ordered = kind === 'number' || kind === 'date' || kind === 'datetime';
    // A date-time filtered by its day, so "same day" and "after this day" read naturally
    const day = typeof value === 'string' && (kind === 'date' || kind === 'datetime') ? value.slice(0, 10) : undefined;

    return (
        <ContextMenuContent className="w-64">
            {cell && (
                <>
                    {edit && (
                        <>
                            <ContextMenuItem onSelect={edit.onEdit}>
                                <Pencil aria-hidden />
                                Edit value
                                <ContextMenuShortcut>Enter</ContextMenuShortcut>
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={edit.onPaste}>
                                <ClipboardPaste aria-hidden />
                                Paste
                                <ContextMenuShortcut>{pasteKeys}</ContextMenuShortcut>
                            </ContextMenuItem>
                            {edit.onFillDown && (
                                <ContextMenuItem onSelect={edit.onFillDown}>
                                    <ArrowDownToLine aria-hidden />
                                    Fill down
                                </ContextMenuItem>
                            )}
                            {edit.onSetNull && (
                                <ContextMenuItem disabled={!range && value === null} onSelect={edit.onSetNull}>
                                    <X aria-hidden />
                                    {range ? `Set ${range.cells.toLocaleString()} cells to NULL` : 'Set to NULL'}
                                    <ContextMenuShortcut>{deleteKey}</ContextMenuShortcut>
                                </ContextMenuItem>
                            )}
                            {edit.onRevert && (
                                <ContextMenuItem onSelect={edit.onRevert}>
                                    <Undo2 aria-hidden />
                                    {range ? 'Revert changes in selection' : 'Revert change'}
                                </ContextMenuItem>
                            )}
                            <ContextMenuSeparator />
                        </>
                    )}
                    <ContextMenuItem onSelect={onShowValue}>
                        <PanelRightOpen aria-hidden />
                        Show value
                        <ContextMenuShortcut>Space</ContextMenuShortcut>
                    </ContextMenuItem>
                    {range ? (
                        <ContextMenuItem onSelect={range.onCopy}>
                            <Copy aria-hidden />
                            Copy {range.cells.toLocaleString()} cells
                            <ContextMenuShortcut>{copyKeys}</ContextMenuShortcut>
                        </ContextMenuItem>
                    ) : (
                        <ContextMenuItem onSelect={() => copy(value ?? null)}>
                            <Copy aria-hidden />
                            Copy value
                            <ContextMenuShortcut>{copyKeys}</ContextMenuShortcut>
                        </ContextMenuItem>
                    )}
                    <ContextMenuSub>
                        <ContextMenuSubTrigger>
                            <ClipboardCopy aria-hidden />
                            Copy as
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent className="w-60">
                            <ContextMenuItem onSelect={() => copy(sqlValue(cell.value, numeric, engine))}>SQL value</ContextMenuItem>
                            <ContextMenuItem
                                onSelect={() =>
                                    copy(cell.value === null ? `${quoted} IS NULL` : `${quoted} = ${sqlValue(cell.value, numeric, engine)}`)
                                }
                            >
                                WHERE condition
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={cell.onCopyRowJson}>Row as JSON</ContextMenuItem>
                            <ContextMenuItem onSelect={cell.onCopyRowTsv}>Row as tab-separated</ContextMenuItem>
                            <ContextMenuItem onSelect={() => copy(name)}>Column name</ContextMenuItem>
                        </ContextMenuSubContent>
                    </ContextMenuSub>

                    {value != null && (reference || referencedBy?.length) && (
                        <>
                            <ContextMenuSeparator />
                            {reference && (
                                <ContextMenuItem
                                    onSelect={() => onOpenRelated(reference, value)}
                                    title={`Open the ${reference.table} row this value points to`}
                                >
                                    <ArrowUpRight aria-hidden />
                                    <span className="min-w-0 truncate">Open referenced row</span>
                                    <ContextMenuShortcut>{openClick}</ContextMenuShortcut>
                                </ContextMenuItem>
                            )}
                            {referencedBy?.length ? (
                                <ContextMenuSub>
                                    <ContextMenuSubTrigger>
                                        <ArrowDownLeft aria-hidden />
                                        Open rows that reference this
                                    </ContextMenuSubTrigger>
                                    <ContextMenuSubContent className="w-60">
                                        {referencedBy.map((r) => (
                                            <ContextMenuItem
                                                key={`${r.schema}.${r.table}.${r.column}`}
                                                onSelect={() => onOpenRelated(r, value)}
                                                title={`${r.schema}.${r.table} where ${r.column} = ${short(value)}`}
                                            >
                                                <span className="truncate font-mono">
                                                    {r.table}.{r.column}
                                                </span>
                                            </ContextMenuItem>
                                        ))}
                                    </ContextMenuSubContent>
                                </ContextMenuSub>
                            ) : null}
                        </>
                    )}

                    <ContextMenuSeparator />
                    <ContextMenuLabel>Filter by this value</ContextMenuLabel>
                    <ContextMenuItem onSelect={() => (value === null ? by('null') : by('=', day ?? value))}>
                        <Filter aria-hidden />
                        <span className="truncate">
                            Only <span className="font-mono">{short(day ?? value ?? null)}</span>
                        </span>
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => (value === null ? by('not null') : by('<>', value))}>
                        <FilterX aria-hidden />
                        <span className="truncate">
                            Hide <span className="font-mono">{short(value ?? null)}</span>
                        </span>
                    </ContextMenuItem>
                    {value !== null && value !== undefined && (ordered || kind === 'text') && (
                        <ContextMenuSub>
                            <ContextMenuSubTrigger>
                                <ChevronsLeftRight aria-hidden />
                                More filters
                            </ContextMenuSubTrigger>
                            <ContextMenuSubContent className="w-60">
                                {ordered ? (
                                    <>
                                        <ContextMenuItem onSelect={() => by('>', day ?? value)}>
                                            {kind === 'number' ? 'Greater than' : 'After'}{' '}
                                            <span className="truncate font-mono">{short(day ?? value)}</span>
                                        </ContextMenuItem>
                                        <ContextMenuItem onSelect={() => by('<', day ?? value)}>
                                            {kind === 'number' ? 'Less than' : 'Before'}{' '}
                                            <span className="truncate font-mono">{short(day ?? value)}</span>
                                        </ContextMenuItem>
                                        {kind === 'number' && (
                                            <>
                                                <ContextMenuItem onSelect={() => by('>=', value)}>
                                                    At least <span className="truncate font-mono">{short(value)}</span>
                                                </ContextMenuItem>
                                                <ContextMenuItem onSelect={() => by('<=', value)}>
                                                    At most <span className="truncate font-mono">{short(value)}</span>
                                                </ContextMenuItem>
                                            </>
                                        )}
                                    </>
                                ) : (
                                    <>
                                        <ContextMenuItem onSelect={() => by('contains', value)}>
                                            Contains <span className="truncate font-mono">{short(value)}</span>
                                        </ContextMenuItem>
                                        <ContextMenuItem onSelect={() => by('starts', value)}>
                                            Starts with <span className="truncate font-mono">{short(value)}</span>
                                        </ContextMenuItem>
                                    </>
                                )}
                                <ContextMenuSeparator />
                                <ContextMenuItem onSelect={() => by('null')}>Is NULL</ContextMenuItem>
                                <ContextMenuItem onSelect={() => by('not null')}>Is not NULL</ContextMenuItem>
                            </ContextMenuSubContent>
                        </ContextMenuSub>
                    )}
                    <ContextMenuSeparator />
                </>
            )}

            <ContextMenuLabel className="truncate">
                Column <span className="font-mono">{name}</span>
            </ContextMenuLabel>
            <ContextMenuItem onSelect={() => onSort({ column: name, desc: false })}>
                <ArrowUp aria-hidden />
                Sort ascending
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onSort({ column: name, desc: true })}>
                <ArrowDown aria-hidden />
                Sort descending
            </ContextMenuItem>
            {sort?.column === name && (
                <ContextMenuItem onSelect={() => onSort(null)}>
                    <X aria-hidden />
                    Clear sort
                </ContextMenuItem>
            )}
            {/* After the menu closes, so it doesn't take focus back from the form */}
            <ContextMenuItem onSelect={() => setTimeout(() => onEditFilter(name))}>
                {kind === 'date' || kind === 'datetime' ? <CalendarRange aria-hidden /> : <ListFilter aria-hidden />}
                {kind === 'date' || kind === 'datetime' ? 'Filter by date…' : 'Filter…'}
            </ContextMenuItem>
            {!cell && (
                <>
                    <ContextMenuItem onSelect={() => by('null')}>Is NULL</ContextMenuItem>
                    <ContextMenuItem onSelect={() => by('not null')}>Is not NULL</ContextMenuItem>
                </>
            )}
            {current && (
                <ContextMenuItem onSelect={() => setFilter(name, null)} title={describeFilter(current)}>
                    <FilterX aria-hidden />
                    Clear this filter
                </ContextMenuItem>
            )}
            {filters.length > 1 && (
                <ContextMenuItem onSelect={onClearFilters}>
                    <FilterX aria-hidden />
                    Clear all {filters.length} filters
                </ContextMenuItem>
            )}
        </ContextMenuContent>
    );
}

/** A row number's menu: copy the selected rows three ways, or select them all */
export function RowMenu({
    rows,
    onCopy,
    onCopyJson,
    onCopyInsert,
    onSelectAll,
    rowOps,
}: {
    rows: number;
    onCopy: () => void;
    onCopyJson: () => void;
    /** Only in a table tab, which knows the table to insert into */
    onCopyInsert?: () => void;
    onSelectAll: () => void;
    /** An editable table tab's: each action only when the login may; `deleted` when every row is staged for deletion */
    rowOps?: { onInsert?: () => void; onDuplicate?: () => void; onDelete?: () => void; deleted: boolean };
}) {
    const what = rows === 1 ? 'row' : `${rows.toLocaleString()} rows`;
    const { onInsert, onDuplicate, onDelete, deleted } = rowOps ?? {};
    return (
        <ContextMenuContent className="w-64">
            {(onInsert || onDuplicate) && (
                <>
                    {onInsert && (
                        <ContextMenuItem onSelect={onInsert}>
                            <Plus aria-hidden />
                            Add row
                        </ContextMenuItem>
                    )}
                    {onDuplicate && (
                        <ContextMenuItem onSelect={onDuplicate}>
                            <Copy aria-hidden />
                            Duplicate {what}
                        </ContextMenuItem>
                    )}
                    <ContextMenuSeparator />
                </>
            )}
            <ContextMenuItem onSelect={onCopy}>
                <Copy aria-hidden />
                Copy {what}
                <ContextMenuShortcut>{copyKeys}</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={onCopyJson}>
                <ClipboardCopy aria-hidden />
                Copy {what} as JSON
            </ContextMenuItem>
            {onCopyInsert && (
                <ContextMenuItem onSelect={onCopyInsert}>
                    <ClipboardCopy aria-hidden />
                    Copy {what} as {rows === 1 ? 'an INSERT statement' : 'INSERT statements'}
                </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onSelectAll}>
                <SquareDashed aria-hidden />
                Select all rows
                <ContextMenuShortcut>{selectAllKeys}</ContextMenuShortcut>
            </ContextMenuItem>
            {onDelete && (
                <>
                    <ContextMenuSeparator />
                    {deleted ? (
                        <ContextMenuItem onSelect={onDelete}>
                            <Undo2 aria-hidden />
                            Restore {what}
                        </ContextMenuItem>
                    ) : (
                        // Staged like any edit: nothing is deleted until Save
                        <ContextMenuDestructiveItem onSelect={onDelete}>
                            <Trash2 aria-hidden />
                            Delete {what}
                        </ContextMenuDestructiveItem>
                    )}
                </>
            )}
        </ContextMenuContent>
    );
}
