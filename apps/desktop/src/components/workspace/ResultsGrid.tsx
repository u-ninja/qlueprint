import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronDown, ChevronUp, Filter, Search, X } from 'lucide-react';
import { useCopy } from '@/lib/use-copy';
import type { ColumnKind, IncomingRef, QueryOutput, ResultColumn, TableDetails } from '@/bindings';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { editCount, qualifiedName, type RowEdit, type Sort } from '@/stores/query';
import type { Connection } from '@/stores/connections';
import { describeFilter, filterKindOf, filterRows, type ColumnFilter } from '@/lib/column-filter';
import { ColumnFilterForm } from './ColumnFilterForm';
import { GridMenu, RowMenu, openClick, short } from './GridMenu';
import { ValuePanel } from './ValuePanel';
import { CellEditor, type CellField } from './CellEditor';
import { referenceOf, type Related } from '@/lib/table-details';
import { fillTarget, fillValues, parseTsv, sameRect, toTsv, type Rect } from '@/lib/cell-range';
import { rowsAsInsert, rowsAsJson } from '@/lib/row-copy';
import { cn, count, isMac } from '@/lib/utils';

type Row = (string | null)[];

const ROW_HEIGHT = 28;
const GUTTER = 52;
// The header row's height (h-7.5), and how close to the grid's top or bottom a drag starts scrolling
const HEADER = 30;
const EDGE = 28;

// Rust decides each column's kind from the driver's type info, for every engine
const kindWidths: Record<ColumnKind, number> = {
    number: 100,
    bool: 84,
    temporal: 190,
    uuid: 300,
    json: 280,
    binary: 200,
    text: 180,
};

/** Fits the type's usual values and the header (name + type label + sort arrow), within reason */
function widthOf({ name, typeName, kind }: ResultColumn) {
    const byType = kindWidths[kind];
    const header = name.length * 7.5 + typeName.length * 6.5 + 52;
    return Math.round(Math.min(Math.max(byType, header), 420));
}

// One collator for every comparison: building one per compare (localeCompare with options) is slow on big sorts
const collator = new Intl.Collator(undefined, { numeric: true });

/** Numbers compare as numbers, everything else as text; NULLs go last either way */
function sortRows(rows: Row[], index: number, numeric: boolean, desc: boolean) {
    const sign = desc ? -1 : 1;
    const compare = numeric ? (a: string, b: string) => Number(a) - Number(b) : collator.compare;
    return [...rows].sort((x, y) => {
        const a = x[index];
        const b = y[index];
        if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
        return sign * compare(a, b);
    });
}

/** Find is case-insensitive and never matches NULL; `query` is already lowercased */
function matchesQuery(value: string | null, query: string) {
    return value !== null && value.toLowerCase().includes(query);
}

/** The next sort for a header click: ascending, then descending, then none */
function nextSort(sort: Sort | null, column: string): Sort | null {
    if (sort?.column !== column) return { column, desc: false };
    return sort.desc ? null : { column, desc: true };
}

/** Edits a table tab's cells in place; the tab stages each change until saved */
export type Editor = {
    /** A row's key in `edits`, or undefined when it can't be edited (no whole primary key) */
    keyOf: (row: Row) => string | undefined;
    edits: Record<string, RowEdit>;
    /** How a column's cells are edited (typed, or picked from a list or calendar), and whether they can be */
    field: (col: number) => CellField;
    /** Stages each cell's value as one undo step; a cell's loaded value unstages it, and NULL in a NOT NULL column is skipped */
    stage: (cells: { row: Row; col: number; to: string | null }[]) => void;
    /** Steps the staged edits back, or forward with `redo` */
    undo: (redo?: boolean) => void;
    /** A cell to select and scroll to (from the Changes panel); `focused` is called once it's taken */
    focus: { row: string; column: string } | null;
    focused: () => void;
    /** Rows staged to be added; a table tab shows them after the loaded ones */
    added: Row[];
    /** Why a loaded row's cells can't be changed though new ones can (no UPDATE grant) */
    locked?: string;
    /** Each only when the login may: add a blank row, add copies of rows (as shown), delete rows or take that back */
    insert?: () => void;
    duplicate?: (rows: Row[]) => void;
    remove?: (rows: Row[], restore?: boolean) => void;
};

type Props = {
    output: QueryOutput;
    sort: Sort | null;
    onSort: (sort: Sort | null) => void;
    /** At most one per column */
    filters: ColumnFilter[];
    onFiltersChange: (filters: ColumnFilter[]) => void;
    /** The database type, so copied names and conditions are quoted the way it reads them */
    engine?: Connection['kind'];
    /** A table tab's details: its foreign keys, both ways, open the related rows */
    details?: TableDetails;
    onOpenRelated?: (target: Related, filter: ColumnFilter) => void;
    editor?: Editor;
    /** A table tab's table, so selected rows can be copied as INSERT statements. Its rows come sorted and
     * filtered by the database; a query result's are sorted and filtered here */
    table?: { schema: string; name: string };
};

/** Virtualized, resizable, sortable, filterable grid for one result set, with find (Ctrl/Cmd+F) */
export function ResultsGrid({
    output,
    sort,
    onSort: setSort,
    filters,
    onFiltersChange,
    engine,
    details,
    onOpenRelated,
    editor,
    table: source,
}: Props) {
    const server = !!source;
    const filterOf = (column: string) => filters.find((f) => f.column === column);
    const setFilter = (column: string, filter: ColumnFilter | null) =>
        onFiltersChange([...filters.filter((f) => f.column !== column), ...(filter ? [filter] : [])]);
    // The column whose filter form is open
    const [editing, setEditing] = useState<string | null>(null);
    const editingColumn = output.columns.find((c) => c.name === editing);

    // Find: highlights matches; on a query result it can also hide the rows without one
    const [findOpen, setFindOpen] = useState(false);
    const [needle, setNeedle] = useState('');
    const [onlyMatches, setOnlyMatches] = useState(false);
    const [current, setCurrent] = useState(0);
    const findRef = useRef<HTMLInputElement>(null);
    // Typing stays responsive on a big result: the scan and highlights catch up after
    const deferredNeedle = useDeferredValue(needle);
    const query = findOpen ? deferredNeedle.trim().toLowerCase() : '';

    const data = useMemo(() => {
        let rows = output.rows;
        if (!server)
            rows = filterRows(
                rows,
                output.columns.map((c) => c.name),
                filters,
            );
        if (!server && onlyMatches && query) rows = rows.filter((row) => row.some((value) => matchesQuery(value, query)));
        if (!server && sort) {
            const index = output.columns.findIndex((c) => c.name === sort.column);
            if (index >= 0) rows = sortRows(rows, index, output.columns[index].kind === 'number', sort.desc);
        }
        // New rows go after the loaded ones, in a table tab only (a query result is sorted and filtered here)
        return server && editor?.added.length ? [...rows, ...editor.added] : rows;
        // `added` is rebuilt only when a row is added or dropped
    }, [output, server, filters, onlyMatches, query, sort, editor?.added]);

    // By column name: where each foreign key points, and the keys elsewhere that point at each column
    const links = useMemo(() => {
        const refs = new Map<string, Related & { label: string }>();
        const incoming = new Map<string, IncomingRef[]>();
        if (!onOpenRelated) return { refs, incoming };
        for (const c of details?.columns ?? [])
            if (c.references && c.referencesColumn)
                refs.set(c.name, { schema: c.referencesSchema ?? '', table: c.references, column: c.referencesColumn, label: referenceOf(c)! });
        for (const r of details?.referencedBy ?? []) incoming.set(r.referencesColumn, [...(incoming.get(r.referencesColumn) ?? []), r]);
        return { refs, incoming };
    }, [details, onOpenRelated]);
    // While ⌘ (Ctrl elsewhere) is down, the cells a click would follow look like links. One listener for the grid, not one per cell
    const [linking, setLinking] = useState(false);
    const hasLinks = links.refs.size > 0;
    useEffect(() => {
        if (!hasLinks) return;
        const update = (e: globalThis.KeyboardEvent) => setLinking(isMac ? e.metaKey : e.ctrlKey);
        const reset = () => setLinking(false);
        window.addEventListener('keydown', update);
        window.addEventListener('keyup', update);
        window.addEventListener('blur', reset);
        return () => {
            window.removeEventListener('keydown', update);
            window.removeEventListener('keyup', update);
            window.removeEventListener('blur', reset);
        };
    }, [hasLinks]);

    // Both sides of a key share a type, so the clicked column says how to filter the other one
    const openRelated = (target: Related, column: ResultColumn, value: string) =>
        onOpenRelated?.(target, { column: target.column, kind: filterKindOf(column.kind, column.typeName), op: '=', value });

    const columns = useMemo<ColumnDef<Row>[]>(
        () =>
            output.columns.map((column, i) => ({
                // Index, not name: a result can have two columns with the same name
                id: String(i),
                header: column.name,
                accessorFn: (row) => row[i],
                size: widthOf(column),
            })),
        [output.columns],
    );
    const table = useReactTable({
        data,
        columns,
        getCoreRowModel: getCoreRowModel(),
        columnResizeMode: 'onChange',
        defaultColumn: { minSize: 56, maxSize: 1200 },
    });
    const rows = table.getRowModel().rows;

    // Every matching cell, in reading order; a Set makes the per-cell highlight check O(1)
    const matches = useMemo(() => {
        if (!query) return [];
        const found: [number, number][] = [];
        data.forEach((row, r) => row.forEach((value, c) => matchesQuery(value, query) && found.push([r, c])));
        return found;
    }, [data, query]);
    const at = matches.length ? Math.min(current, matches.length - 1) : -1;

    const scrollRef = useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
    });

    // A new result starts at the top-left, not wherever the previous one was scrolled to
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: 0, left: 0 });
    }, [output]);

    /** Brings a cell into view, sideways too: the row gutter is sticky, so a cell under it counts as hidden */
    const scrollToCell = (r: number, c: number) => {
        const el = scrollRef.current;
        if (!el) return;
        virtualizer.scrollToIndex(r, { align: 'auto' });
        const column = table.getColumn(String(c));
        if (!column) return;
        const left = GUTTER + column.getStart();
        const right = left + column.getSize();
        if (left < el.scrollLeft + GUTTER) el.scrollLeft = left - GUTTER;
        else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    };
    // Only a new current match scrolls; scrollToCell itself reads the latest table and virtualizer
    const scrollRefFn = useRef(scrollToCell);
    scrollRefFn.current = scrollToCell;
    useEffect(() => {
        if (at >= 0) scrollRefFn.current(...matches[at]);
    }, [at, matches]);

    // The selected cell (row, col) and the range's far corner, tagged with the rows they were picked in:
    // a re-sort, filter or new result clears them
    const [picked, setPicked] = useState<{ in: Row[]; row: number; col: number; toRow: number; toCol: number } | null>(null);
    const selected = picked?.in === data ? picked : null;
    const range: Rect | null = selected && {
        r0: Math.min(selected.row, selected.toRow),
        r1: Math.max(selected.row, selected.toRow),
        c0: Math.min(selected.col, selected.toCol),
        c1: Math.max(selected.col, selected.toCol),
    };
    const multi = !!range && (range.r0 !== range.r1 || range.c0 !== range.c1);
    const lastCol = output.columns.length - 1;
    // Whole rows, as picked from the row numbers: still a rectangle, just one spanning every column
    const wholeRows = !!range && range.c0 === 0 && range.c1 === lastCol;
    /** Selects a cell, or with `extend` grows the range to it; the same pick keeps the state, so a drag over one cell doesn't re-render */
    const pick = (row: number, col: number, extend = false) =>
        setPicked((p) =>
            extend && p?.in === data
                ? p.toRow === row && p.toCol === col
                    ? p
                    : { ...p, toRow: row, toCol: col }
                : { in: data, row, col, toRow: row, toCol: col },
        );
    const pickRect = (r: Rect) => setPicked({ in: data, row: r.r0, col: r.c0, toRow: r.r1, toCol: r.c1 });
    const pickRows = (r0: number, r1 = r0) => pickRect({ r0, r1, c0: 0, c1: lastCol });
    const [previewing, setPreviewing] = useState(false);

    // The cell being edited, tagged like `picked`
    const [typing, setTyping] = useState<{ in: Row[]; row: number; col: number } | null>(null);
    const input = typing?.in === data ? typing : null;
    /** What a cell shows: its staged value when it has one */
    const staged = (row: Row, col: number) => {
        const key = editor?.keyOf(row);
        return key === undefined ? undefined : editor?.edits[key]?.changes[output.columns[col].name];
    };
    const valueAt = (r: number, c: number) => {
        const change = staged(data[r], c);
        return change ? change.to : data[r][c];
    };
    /** Whether a row is staged to be added or deleted; `key` is its row's, when already known */
    const opOf = (row: Row, key = editor?.keyOf(row)) => (key === undefined ? undefined : editor?.edits[key]?.op);
    /** Why a cell can't be edited, or undefined when it can; `key` is its row's, when already known */
    const lockedAt = (r: number, c: number, key = editor?.keyOf(data[r])) => {
        if (!editor) return 'Read-only';
        if (key === undefined) return 'Read-only: this row has no primary key value';
        const op = opOf(data[r], key);
        if (op === 'delete') return 'Deleted: restore the row to edit it';
        return (op !== 'insert' && editor.locked) || editor.field(c).readOnly;
    };
    /** Edits the cell when it can be, otherwise shows its value */
    const open = (row: number, col: number) => {
        pick(row, col);
        if (lockedAt(row, col)) setPreviewing(true);
        else setTyping({ in: data, row, col });
    };

    const select = (row: number, col: number, extend = false) => {
        pick(row, col, extend);
        scrollToCell(row, col);
    };

    // A jump from the Changes panel: taken once, then cleared; select reads the latest rows through the ref
    const selectFn = useRef(select);
    selectFn.current = select;
    const focus = editor?.focus;
    useEffect(() => {
        if (!focus || !editor) return;
        const r = data.findIndex((row) => editor.keyOf(row) === focus.row);
        // No column (a row just added): its first
        const c = Math.max(
            output.columns.findIndex((col) => col.name === focus.column),
            0,
        );
        if (r >= 0) {
            selectFn.current(r, c);
            scrollRef.current?.focus({ preventScroll: true });
        }
        editor.focused();
        // Per request only: `editor` is a new object every render
    }, [focus]);

    const [copied, copy] = useCopy();
    // A short note in the status corner, e.g. why a paste didn't happen
    const [notice, setNotice] = useState('');
    useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(''), 2500);
        return () => clearTimeout(timer);
    }, [notice]);

    /** Stages the cells that can be edited, as one undo step */
    const stageCells = (cells: { r: number; c: number; to: string | null }[]) =>
        editor?.stage(cells.filter(({ r, c }) => !lockedAt(r, c)).map(({ r, c, to }) => ({ row: data[r], col: c, to })));
    /** Stages `to(r, c)` into every editable cell of the rectangle, as one undo step; undefined leaves a cell */
    const stageRect = ({ r0, r1, c0, c1 }: Rect, to: (r: number, c: number) => string | null | undefined) => {
        const cells: { r: number; c: number; to: string | null }[] = [];
        for (let r = r0; r <= r1; r++)
            for (let c = c0; c <= c1; c++) {
                const value = to(r, c);
                if (value !== undefined) cells.push({ r, c, to: value });
            }
        stageCells(cells);
    };
    /** The range's rows, every column, as shown (staged values included) */
    const selectedRows = ({ r0, r1 }: Pick<Rect, 'r0' | 'r1'>) => data.slice(r0, r1 + 1).map((row, i) => row.map((_, c) => valueAt(r0 + i, c)));
    const copyRange = ({ r0, r1, c0, c1 }: Rect) =>
        copy(toTsv(data.slice(r0, r1 + 1).map((_, i) => output.columns.slice(c0, c1 + 1).map((_, j) => valueAt(r0 + i, c0 + j)))));
    /**
     * Pastes spreadsheet text at the range's top-left, or one value into the whole range. Empty cells
     * become NULL, as copying wrote NULL as empty; anything past the loaded rows or columns is dropped
     */
    const paste = (text: string, at: Rect) => {
        const clip = parseTsv(text);
        const one = clip.length === 1 && clip[0].length === 1;
        const into = one
            ? at
            : {
                  ...at,
                  r1: Math.min(at.r0 + clip.length, data.length) - 1,
                  c1: Math.min(at.c0 + Math.max(...clip.map((r) => r.length)), output.columns.length) - 1,
              };
        stageRect(into, (r, c) => {
            const value = one ? clip[0][0] : clip[r - at.r0][c - at.c0];
            return value === undefined ? undefined : value || null;
        });
        pickRect(into);
    };
    const pasteFromClipboard = (at: Rect) =>
        navigator.clipboard.readText().then(
            (text) => paste(text, at),
            () => setNotice('Couldn’t read the clipboard'),
        );
    /** Fills `target` (the selection grown along one axis) from the selection: numbers in a numeric column run on as a series, the rest repeat */
    const fill = (sel: Rect, target: Rect) => {
        const cells: { r: number; c: number; to: string | null }[] = [];
        const vertical = target.r0 < sel.r0 || target.r1 > sel.r1;
        const back = target.r0 < sel.r0 || target.c0 < sel.c0;
        const n = vertical ? target.r1 - target.r0 - (sel.r1 - sel.r0) : target.c1 - target.c0 - (sel.c1 - sel.c0);
        const [lines, span] = vertical
            ? [
                  [sel.c0, sel.c1],
                  [sel.r0, sel.r1],
              ]
            : [
                  [sel.r0, sel.r1],
                  [sel.c0, sel.c1],
              ];
        for (let line = lines[0]; line <= lines[1]; line++) {
            const at = (i: number) => (vertical ? ([i, line] as const) : ([line, i] as const));
            const source: (string | null)[] = [];
            for (let i = span[0]; i <= span[1]; i++) source.push(valueAt(...at(i)));
            const numeric = vertical
                ? output.columns[line].kind === 'number'
                : output.columns.slice(sel.c0, sel.c1 + 1).every((c) => c.kind === 'number');
            // Filling up or left continues away from the selection, so the source reads backwards
            fillValues(back ? source.reverse() : source, n, numeric).forEach((to, k) => {
                const [r, c] = at(back ? span[0] - 1 - k : span[1] + 1 + k);
                cells.push({ r, c, to });
            });
        }
        stageCells(cells);
        pickRect(target);
    };

    // Dragging across cells selects them; dragging the fill handle previews where it fills, and fills on release
    const drag = useRef<'select' | 'rows' | 'fill' | null>(null);
    const [fillTo, setFillTo] = useState<Rect | null>(null);
    const fillRef = useRef<Rect | null>(null);
    const endDrag = useRef<() => void>(undefined);
    endDrag.current = () => {
        if (drag.current === 'fill' && range && fillRef.current) fill(range, fillRef.current);
        drag.current = null;
        fillRef.current = null;
        setFillTo(null);
    };
    /** Starts a drag; while the pointer is held near the grid's top or bottom, one rAF loop scrolls and keeps extending it */
    const startDrag = (kind: 'select' | 'rows' | 'fill') => {
        drag.current = kind;
        let x = 0;
        let y = 0;
        let frame = 0;
        const tick = () => {
            frame = 0;
            const el = scrollRef.current;
            if (!el || !drag.current) return;
            const box = el.getBoundingClientRect();
            const top = box.top + HEADER;
            const past = y < top + EDGE ? y - top - EDGE : y > box.bottom - EDGE ? y - box.bottom + EDGE : 0;
            if (!past) return;
            // Faster the further past the edge, capped
            el.scrollTop += Math.max(-24, Math.min(24, past / 2));
            // The rows moved under a still pointer: extend to whatever is there now, clamped inside the rows
            const hit = document.elementFromPoint(Math.min(Math.max(x, box.left + 1), box.right - 1), Math.min(Math.max(y, top + 1), box.bottom - 1));
            if (hit) dragOver.current({ target: hit });
            frame = requestAnimationFrame(tick);
        };
        const move = (e: MouseEvent) => {
            x = e.clientX;
            y = e.clientY;
            if (!frame) frame = requestAnimationFrame(tick);
        };
        const up = () => {
            window.removeEventListener('mouseup', up);
            window.removeEventListener('mousemove', move);
            cancelAnimationFrame(frame);
            endDrag.current?.();
        };
        window.addEventListener('mouseup', up);
        window.addEventListener('mousemove', move);
    };
    const onDragOver = (e: { target: EventTarget }) => {
        if (!drag.current || !range) return;
        // A cell, or a row number (no data-col)
        const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
        if (!cell) return;
        const r = Number(cell.dataset.row);
        if (drag.current === 'rows') return pick(r, lastCol, true);
        if (cell.dataset.col === undefined) return;
        const c = Number(cell.dataset.col);
        if (drag.current === 'select') return pick(r, c, true);
        const target = fillTarget(range, r, c);
        if (sameRect(fillRef.current, target)) return;
        fillRef.current = target;
        setFillTo(target);
    };
    // The auto-scroll loop outlives the render that started it
    const dragOver = useRef(onDragOver);
    dragOver.current = onDragOver;
    /** Where a rectangle sits over the rows, for the selection outline and the fill preview */
    const rectStyle = ({ r0, r1, c0, c1 }: Rect) => {
        const first = table.getColumn(String(c0));
        const last = table.getColumn(String(c1));
        if (!first || !last) return undefined;
        const left = GUTTER + first.getStart();
        return { top: r0 * ROW_HEIGHT, height: (r1 - r0 + 1) * ROW_HEIGHT, left, width: last.getStart() + last.getSize() + GUTTER - left };
    };

    const openFind = () => {
        setFindOpen(true);
        // Already open: just focus and select, so typing replaces the old search
        requestAnimationFrame(() => findRef.current?.select());
    };
    const closeFind = () => {
        setFindOpen(false);
        setOnlyMatches(false);
        scrollRef.current?.focus();
    };
    const step = (by: number) => matches.length && setCurrent((at + by + matches.length) % matches.length);

    const onGridKeyDown = (e: KeyboardEvent) => {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            openFind();
            return;
        }
        // The rest act only from the grid itself, not the find box or a menu
        if (e.target !== scrollRef.current) return;
        const key = e.key.toLowerCase();
        // Undo needs no selection: ⌘Z / ⌘⇧Z, and Ctrl+Y off macOS
        const redo = mod && (key === 'z' ? e.shiftKey : !isMac && e.ctrlKey && key === 'y');
        if (editor && mod && (key === 'z' || redo)) {
            e.preventDefault();
            return editor.undo(redo);
        }
        if (mod && key === 'a' && data.length) {
            e.preventDefault();
            return pickRows(0, data.length - 1);
        }
        if (!selected || !range) return;
        const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
        const move = moves[e.key];
        if (move) {
            // Shift moves the range's far corner; the selected cell stays put, as in a spreadsheet
            const [row, col] = e.shiftKey ? [selected.toRow, selected.toCol] : [selected.row, selected.col];
            select(
                Math.min(Math.max(row + move[0], 0), data.length - 1),
                Math.min(Math.max(col + move[1], 0), output.columns.length - 1),
                e.shiftKey,
            );
        } else if (e.key === ' ') setPreviewing(!previewing);
        else if (e.key === 'Enter' && editor && !lockedAt(selected.row, selected.col)) open(selected.row, selected.col);
        else if (e.key === 'Escape' && multi) pick(selected.row, selected.col);
        else if (e.key === 'Escape' && previewing) setPreviewing(false);
        // ⌘C copies the cell or range, unless the user selected some text to copy instead
        else if (mod && key === 'c' && !window.getSelection()?.toString()) {
            if (multi) copyRange(range);
            else copy(valueAt(selected.row, selected.col));
        } else if (editor && mod && key === 'v') void pasteFromClipboard(range);
        else if (editor && (e.key === 'Delete' || e.key === 'Backspace')) stageRect(range, () => null);
        else return;
        e.preventDefault();
    };
    const onFindKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
        else if (e.key === 'Escape') closeFind();
        else return;
        e.preventDefault();
        e.stopPropagation();
    };

    // The cell under the last right-click, read from data attributes so one menu serves every cell
    // row null: the column's header
    // rows: a row number, whose menu acts on the selected rows
    const [target, setTarget] = useState<{ row: number | null; col: number; rows?: true } | null>(null);
    const targetMeta = target ? output.columns[target.col] : undefined;
    const anyEdits = !!editor && editCount(editor) > 0;
    /** Add, duplicate, delete or restore the range's rows, as far as the login may */
    const rowOps = ({ r0, r1 }: Pick<Rect, 'r0' | 'r1'>) => {
        if (!editor) return undefined;
        const { insert, duplicate, remove } = editor;
        // Rendered while the menu is open: no scan of the range without staged edits
        let deleted = anyEdits;
        for (let r = r0; deleted && r <= r1; r++) deleted = opOf(data[r]) === 'delete';
        return {
            onInsert: insert,
            onDuplicate: duplicate && (() => duplicate(selectedRows({ r0, r1 }))),
            onDelete: remove && (() => remove(data.slice(r0, r1 + 1), deleted)),
            deleted,
        };
    };

    const status = copied
        ? 'Copied'
        : notice ||
          (multi && range && wholeRows
              ? count(range.r1 - range.r0 + 1, 'row')
              : multi && range
                ? `${count((range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1), 'cell')} · ${(range.r1 - range.r0 + 1).toLocaleString()} × ${(range.c1 - range.c0 + 1).toLocaleString()}`
                : '');

    // Sorting or hiding rows here only covers what was loaded; say so when the row cap cut the result short
    const partial = !server && output.truncated && (sort !== null || filters.length > 0 || (onlyMatches && !!query));
    const width = GUTTER + table.getTotalSize();
    const gutter = 'sticky left-0 z-10 flex w-13 flex-none items-center justify-end border-r border-border-soft pr-2.5';
    const findButton = 'grid size-6 flex-none place-items-center rounded text-fg3 hover:bg-hover hover:text-foreground disabled:opacity-40';

    return (
        <Popover open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
            <div className="flex h-full" onKeyDown={onGridKeyDown}>
                <div className="relative h-full min-w-0 flex-1">
                    {/* The menu's target clears as it closes, so its props (a scan for staged changes) aren't rebuilt on every render */}
                    <ContextMenu onOpenChange={(open) => !open && setTarget(null)}>
                        <ContextMenuTrigger asChild>
                            <div
                                ref={scrollRef}
                                tabIndex={0}
                                aria-label="Results. Ctrl or Command F to find"
                                className="h-full overflow-auto text-[12.5px] outline-none select-text focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
                                onMouseOver={onDragOver}
                                // One handler for every row number: click selects the row, Shift extends from the anchor row, drag selects a block
                                onMouseDown={(e) => {
                                    const head = (e.target as HTMLElement).closest<HTMLElement>('[data-row-head]');
                                    if (!head || e.button !== 0) return;
                                    e.preventDefault();
                                    scrollRef.current?.focus({ preventScroll: true });
                                    const r = Number(head.dataset.row);
                                    if (e.shiftKey && selected) setPicked({ ...selected, col: 0, toRow: r, toCol: lastCol });
                                    else pickRows(r);
                                    startDrag('rows');
                                }}
                                onContextMenu={(e) => {
                                    const el = e.target as HTMLElement;
                                    const rowHead = el.closest<HTMLElement>('[data-row-head]');
                                    if (rowHead) {
                                        const r = Number(rowHead.dataset.row);
                                        // Inside selected rows the menu acts on all of them; elsewhere it selects the clicked row first
                                        if (!(range && wholeRows && r >= range.r0 && r <= range.r1)) pickRows(r);
                                        setTarget({ row: r, col: 0, rows: true });
                                        return;
                                    }
                                    const cell = el.closest<HTMLElement>('[data-col]');
                                    const head = el.closest<HTMLElement>('[data-header-col]');
                                    const row = Number(cell?.dataset.row);
                                    const col = Number(cell?.dataset.col);
                                    // Inside the range the menu acts on all of it; elsewhere it selects the clicked cell first
                                    if (cell && !(range && row >= range.r0 && row <= range.r1 && col >= range.c0 && col <= range.c1)) pick(row, col);
                                    setTarget(cell ? { row, col } : head ? { row: null, col: Number(head.dataset.headerCol) } : null);
                                }}
                            >
                                <div
                                    role="table"
                                    aria-label="Query results"
                                    aria-rowcount={rows.length + 1}
                                    aria-colcount={columns.length}
                                    style={{ width, minWidth: '100%' }}
                                >
                                    <div role="row" aria-rowindex={1} className="sticky top-0 z-20 flex h-7.5 border-b border-border-soft bg-header">
                                        <div role="columnheader" aria-label="Row number" className={cn(gutter, 'z-30 justify-center bg-header pr-0')}>
                                            <button
                                                onClick={openFind}
                                                aria-label="Find in results"
                                                title="Find in results (Ctrl/Cmd+F)"
                                                className={findButton}
                                            >
                                                <Search className="size-3.5" aria-hidden />
                                            </button>
                                        </div>
                                        {table.getHeaderGroups()[0].headers.map((header) => {
                                            const column = output.columns[header.index];
                                            const numeric = column.kind === 'number';
                                            const sorted = sort?.column === column.name ? (sort.desc ? 'descending' : 'ascending') : undefined;
                                            const Arrow = sorted === 'descending' ? ArrowDown : ArrowUp;
                                            const filtered = filterOf(column.name);
                                            const ref = links.refs.get(column.name);
                                            const cell = (
                                                <div
                                                    key={header.id}
                                                    role="columnheader"
                                                    aria-sort={sorted ?? 'none'}
                                                    data-header-col={header.index}
                                                    style={{ width: header.getSize() }}
                                                    className="relative flex flex-none border-r border-border-soft"
                                                >
                                                    {/* The whole header is the sort target: a big, familiar click target */}
                                                    <button
                                                        onClick={() => setSort(nextSort(sort, column.name))}
                                                        title={`Sort by ${column.name}${server ? '' : ' (loaded rows)'}${ref ? `\nreferences ${ref.label}` : ''}`}
                                                        className={cn(
                                                            // Inset ring: an outline would be clipped by the sticky header and its neighbours
                                                            'group/sort flex min-w-0 flex-1 items-center gap-1.5 px-2.5 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
                                                            numeric && 'justify-end',
                                                        )}
                                                    >
                                                        <span className="truncate font-medium">
                                                            {flexRender(header.column.columnDef.header, header.getContext())}
                                                        </span>
                                                        <span className="flex-none font-mono text-[10.5px] text-fg4">
                                                            {column.typeName.toLowerCase()}
                                                        </span>
                                                        {ref && (
                                                            <ArrowUpRight
                                                                aria-label={`references ${ref.label}`}
                                                                className="size-3 flex-none text-fg3"
                                                            />
                                                        )}
                                                        {filtered && (
                                                            <Filter
                                                                aria-label={`Filtered: ${describeFilter(filtered)}`}
                                                                className="size-3 flex-none text-primary-text"
                                                            />
                                                        )}
                                                        <Arrow
                                                            aria-hidden
                                                            className={cn(
                                                                'size-3 flex-none',
                                                                sorted ? 'text-primary-text' : 'text-fg4 opacity-0 group-hover/sort:opacity-100',
                                                            )}
                                                        />
                                                    </button>
                                                    {/* Drag to resize, double-click to reset */}
                                                    <div
                                                        onMouseDown={header.getResizeHandler()}
                                                        onTouchStart={header.getResizeHandler()}
                                                        onDoubleClick={() => header.column.resetSize()}
                                                        aria-hidden
                                                        className={cn(
                                                            'absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none select-none hover:bg-primary/40',
                                                            header.column.getIsResizing() && 'bg-primary/60',
                                                        )}
                                                    />
                                                </div>
                                            );
                                            // The open filter form points at its column's header
                                            return editing === column.name ? (
                                                <PopoverAnchor asChild key={header.id}>
                                                    {cell}
                                                </PopoverAnchor>
                                            ) : (
                                                cell
                                            );
                                        })}
                                    </div>

                                    <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
                                        {virtualizer.getVirtualItems().map((item) => {
                                            const row = rows[item.index];
                                            // Once per row, not per cell; its staged changes only looked up when there are any
                                            const key = editor?.keyOf(row.original);
                                            const rowEdits = key !== undefined && anyEdits ? editor!.edits[key] : undefined;
                                            const deleted = rowEdits?.op === 'delete';
                                            const isNew = rowEdits?.op === 'insert';
                                            const rowSelected = !!range && wholeRows && item.index >= range.r0 && item.index <= range.r1;
                                            return (
                                                <div
                                                    key={row.id}
                                                    role="row"
                                                    aria-rowindex={item.index + 2}
                                                    className={cn(
                                                        'group absolute left-0 flex w-full border-b border-border-soft hover:bg-hover',
                                                        deleted && 'bg-danger-soft text-fg3 line-through decoration-fg4',
                                                        isNew && 'bg-success-soft',
                                                    )}
                                                    // top, not transform: a transformed row gets its own layer, and WebKit paints those over the overlay scrollbar
                                                    style={{ height: ROW_HEIGHT, top: item.start }}
                                                >
                                                    <div
                                                        role="rowheader"
                                                        data-row={item.index}
                                                        data-row-head=""
                                                        aria-selected={rowSelected}
                                                        title="Click to select the row, drag or Shift-click for more"
                                                        className={cn(
                                                            gutter,
                                                            'cursor-default bg-surface font-mono text-[11px] text-fg4 tabular-nums select-none',
                                                            // The gutter is sticky over the cells, so the translucent tint goes on top of an opaque surface
                                                            rowSelected && 'bg-linear-to-r from-primary-soft to-primary-soft text-primary-text',
                                                        )}
                                                    >
                                                        {isNew ? (
                                                            <span title="New row, not saved yet">+</span>
                                                        ) : (
                                                            <span title={deleted ? 'Deleted, not saved yet' : undefined}>{item.index + 1}</span>
                                                        )}
                                                        {(isNew || deleted) && <span className="sr-only">{isNew ? ', new' : ', deleted'}</span>}
                                                    </div>
                                                    {row.getVisibleCells().map((cell) => {
                                                        const col = cell.column.getIndex();
                                                        const change = rowEdits?.changes[output.columns[col].name];
                                                        const value = change ? change.to : cell.getValue<string | null>();
                                                        const isTyping = input?.row === item.index && input.col === col;
                                                        const locked = editor && lockedAt(item.index, col, key);
                                                        const { kind } = output.columns[col];
                                                        const numeric = kind === 'number';
                                                        // Values compared character by character (figures, times, ids, JSON, bytes) are set in mono
                                                        const mono = kind !== 'text';
                                                        // Only visible cells render, so checking each one beats keeping a set of every match
                                                        const match = !!query && matchesQuery(value, query);
                                                        const isCurrent = match && matches[at]?.[0] === item.index && matches[at]?.[1] === col;
                                                        const isSelected = selected?.row === item.index && selected.col === col;
                                                        const inRange =
                                                            !!range &&
                                                            multi &&
                                                            item.index >= range.r0 &&
                                                            item.index <= range.r1 &&
                                                            col >= range.c0 &&
                                                            col <= range.c1;
                                                        // Follows the loaded value: a staged one isn't in the database yet
                                                        const loaded = cell.getValue<string | null>();
                                                        const ref = loaded !== null ? links.refs.get(output.columns[col].name) : undefined;
                                                        return (
                                                            <div
                                                                key={cell.id}
                                                                role="cell"
                                                                data-row={item.index}
                                                                data-col={col}
                                                                onMouseDown={(e) => {
                                                                    // ⌘-click on a link is left to onClick
                                                                    if (e.button !== 0 || (ref && loaded !== null && (isMac ? e.metaKey : e.ctrlKey)))
                                                                        return;
                                                                    // Dragging selects cells, not text (and a double-click doesn't select a word)
                                                                    e.preventDefault();
                                                                    scrollRef.current?.focus({ preventScroll: true });
                                                                    pick(item.index, col, e.shiftKey);
                                                                    startDrag('select');
                                                                }}
                                                                onClick={(e) => {
                                                                    if (ref && loaded !== null && (isMac ? e.metaKey : e.ctrlKey))
                                                                        openRelated(ref, output.columns[col], loaded);
                                                                }}
                                                                onDoubleClick={() => open(item.index, col)}
                                                                aria-selected={isSelected || inRange}
                                                                title={
                                                                    ref
                                                                        ? `${openClick} to open ${ref.table} where ${ref.column} = ${short(loaded)}`
                                                                        : change
                                                                          ? `Was ${short(change.from)}, not saved yet`
                                                                          : value !== null && value.length > 40
                                                                            ? value
                                                                            : editor && !locked
                                                                              ? 'Double-click to edit'
                                                                              : (locked ?? 'Double-click to see the whole value')
                                                                }
                                                                style={{ width: cell.column.getSize() }}
                                                                className={cn(
                                                                    'flex flex-none items-center overflow-hidden px-2.5 whitespace-nowrap',
                                                                    numeric && 'justify-end tabular-nums',
                                                                    mono && 'font-mono text-xs',
                                                                    // NULL reads as a marker, not a value: small mono, muted, never italic
                                                                    (value === null || (isNew && !change)) && 'font-mono text-[11px] text-fg4',
                                                                    match && 'bg-warning-soft',
                                                                    isCurrent && 'ring-1 ring-warning ring-inset',
                                                                    change && 'relative bg-warning-soft',
                                                                    inRange && 'bg-primary-soft',
                                                                    isSelected && 'bg-primary-soft ring-1 ring-primary ring-inset',
                                                                    ref && 'decoration-fg4 decoration-dotted underline-offset-2 hover:underline',
                                                                    ref && linking && 'cursor-pointer underline decoration-solid',
                                                                    isTyping && 'p-0',
                                                                )}
                                                            >
                                                                {isTyping ? (
                                                                    <CellEditor
                                                                        value={value}
                                                                        field={editor!.field(col)}
                                                                        className="h-full w-full min-w-0 bg-elev px-2.5 text-foreground ring-1 ring-primary outline-none ring-inset"
                                                                        onDone={(to, refocus) => {
                                                                            setTyping(null);
                                                                            if (to !== undefined) editor?.stage([{ row: row.original, col, to }]);
                                                                            if (refocus) scrollRef.current?.focus();
                                                                        }}
                                                                    />
                                                                ) : (
                                                                    // A new row's column left unset takes the table's default
                                                                    <span className="truncate">
                                                                        {isNew && !change ? 'DEFAULT' : (value ?? 'NULL')}
                                                                    </span>
                                                                )}
                                                                {change && !isTyping && (
                                                                    // Changed, not saved: a dot in the corner, besides the tint
                                                                    <>
                                                                        <span
                                                                            aria-hidden
                                                                            className="absolute top-1 right-1 size-1.5 rounded-full bg-warning"
                                                                        />
                                                                        <span className="sr-only">, changed</span>
                                                                    </>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            );
                                        })}
                                        {range && (multi || editor) && (
                                            // One outline over the range, not a border per cell; the fill handle sits on its corner
                                            <div
                                                aria-hidden
                                                className={cn('pointer-events-none absolute z-[5]', multi && 'ring-1 ring-primary ring-inset')}
                                                style={rectStyle(range)}
                                            >
                                                {editor && (
                                                    <div
                                                        title="Drag to fill, double-click to fill down"
                                                        onMouseDown={(e) => {
                                                            if (e.button !== 0) return;
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                            scrollRef.current?.focus({ preventScroll: true });
                                                            startDrag('fill');
                                                        }}
                                                        onDoubleClick={() =>
                                                            range.r1 < data.length - 1 && fill(range, { ...range, r1: data.length - 1 })
                                                        }
                                                        className="pointer-events-auto absolute -right-[3px] -bottom-[3px] size-[7px] cursor-crosshair border border-surface bg-primary"
                                                    />
                                                )}
                                            </div>
                                        )}
                                        {fillTo && (
                                            <div
                                                aria-hidden
                                                className="pointer-events-none absolute z-[5] border border-dashed border-primary"
                                                style={rectStyle(fillTo)}
                                            />
                                        )}
                                    </div>
                                </div>
                                {rows.length === 0 && (
                                    <p className="sticky left-0 px-4 py-6 text-center text-fg3">
                                        {(onlyMatches && query) || filters.length ? 'No rows match' : 'No rows'}
                                    </p>
                                )}
                            </div>
                        </ContextMenuTrigger>
                        {target?.rows && range ? (
                            <RowMenu
                                rows={range.r1 - range.r0 + 1}
                                onCopy={() => copyRange({ ...range, c0: 0, c1: lastCol })}
                                onCopyJson={() => copy(rowsAsJson(output.columns, selectedRows(range)))}
                                onCopyInsert={
                                    source && engine
                                        ? () =>
                                              copy(
                                                  rowsAsInsert(
                                                      engine,
                                                      qualifiedName(engine, source.schema, source.name),
                                                      output.columns,
                                                      selectedRows(range),
                                                  ),
                                              )
                                        : undefined
                                }
                                onSelectAll={() => pickRows(0, data.length - 1)}
                                rowOps={server ? rowOps(range) : undefined}
                            />
                        ) : (
                            targetMeta && (
                                <GridMenu
                                    column={targetMeta}
                                    cell={
                                        target && target.row !== null && data[target.row]
                                            ? {
                                                  value: valueAt(target.row, target.col),
                                                  onCopyRowJson: () =>
                                                      copy(rowsAsJson(output.columns, selectedRows({ r0: target.row!, r1: target.row! }))),
                                                  onCopyRowTsv: () => copy(toTsv(selectedRows({ r0: target.row!, r1: target.row! }))),
                                              }
                                            : undefined
                                    }
                                    range={
                                        multi && range
                                            ? { cells: (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1), onCopy: () => copyRange(range) }
                                            : undefined
                                    }
                                    edit={
                                        editor && range && target && target.row !== null && data[target.row] && !lockedAt(target.row, target.col)
                                            ? {
                                                  onEdit: () => setTimeout(() => open(target.row!, target.col)),
                                                  // Not offered when every column in the range is NOT NULL
                                                  onSetNull: output.columns.some((_, c) => c >= range.c0 && c <= range.c1 && editor.field(c).nullable)
                                                      ? () => stageRect(range, () => null)
                                                      : undefined,
                                                  onRevert:
                                                      anyEdits &&
                                                      data
                                                          .slice(range.r0, range.r1 + 1)
                                                          .some((row) =>
                                                              output.columns.slice(range.c0, range.c1 + 1).some((_, i) => staged(row, range.c0 + i)),
                                                          )
                                                          ? () => stageRect(range, (r, c) => data[r][c])
                                                          : undefined,
                                                  onPaste: () => void pasteFromClipboard(range),
                                                  onFillDown:
                                                      range.r1 > range.r0
                                                          ? () => stageRect({ ...range, r0: range.r0 + 1 }, (_, c) => valueAt(range.r0, c))
                                                          : undefined,
                                              }
                                            : undefined
                                    }
                                    engine={engine}
                                    reference={links.refs.get(targetMeta.name)}
                                    referencedBy={links.incoming.get(targetMeta.name)}
                                    onOpenRelated={(r, value) => openRelated(r, targetMeta, value)}
                                    sort={sort}
                                    filters={filters}
                                    onSort={setSort}
                                    setFilter={setFilter}
                                    onClearFilters={() => onFiltersChange([])}
                                    onEditFilter={setEditing}
                                    onShowValue={() => {
                                        if (target?.row == null) return;
                                        pick(target.row, target.col);
                                        setPreviewing(true);
                                    }}
                                    copy={copy}
                                />
                            )
                        )}
                    </ContextMenu>
                    {editing && (
                        <PopoverContent onOpenAutoFocus={(e) => e.preventDefault()} className="w-64 p-2.5">
                            <ColumnFilterForm
                                // A fresh form per column, starting from its current filter
                                key={editing}
                                column={editing}
                                kind={editingColumn ? filterKindOf(editingColumn.kind, editingColumn.typeName) : 'text'}
                                initial={filterOf(editing)}
                                onApply={(f) => {
                                    setFilter(editing, f);
                                    setEditing(null);
                                }}
                                onClear={
                                    filterOf(editing)
                                        ? () => {
                                              setFilter(editing, null);
                                              setEditing(null);
                                          }
                                        : undefined
                                }
                            />
                        </PopoverContent>
                    )}

                    {findOpen && (
                        // Top right, like a browser's or the editor's find: where people already look for it
                        <div
                            role="search"
                            className="absolute top-9 right-3 z-40 flex items-center gap-1 rounded-lg bg-elev p-1 pl-2 text-xs shadow-md ring-1 ring-border has-[input:focus-visible]:ring-ring/60"
                        >
                            <Search className="size-3.5 flex-none text-fg3" aria-hidden />
                            <input
                                ref={findRef}
                                autoFocus
                                value={needle}
                                onChange={(e) => {
                                    setNeedle(e.target.value);
                                    setCurrent(0);
                                }}
                                onKeyDown={onFindKeyDown}
                                placeholder="Find in results…"
                                autoComplete="off"
                                aria-label="Find in results"
                                spellCheck={false}
                                className="w-44 bg-transparent py-1 text-[13px] outline-none placeholder:text-fg4"
                            />
                            <span role="status" className="min-w-[7ch] flex-none text-right font-mono text-[11px] text-fg3 tabular-nums">
                                {query ? (matches.length ? `${at + 1} of ${matches.length.toLocaleString()}` : 'No results') : ''}
                            </span>
                            <button
                                onClick={() => step(-1)}
                                disabled={!matches.length}
                                aria-label="Previous match"
                                title="Previous (Shift+Enter)"
                                className={findButton}
                            >
                                <ChevronUp className="size-3.5" aria-hidden />
                            </button>
                            <button
                                onClick={() => step(1)}
                                disabled={!matches.length}
                                aria-label="Next match"
                                title="Next (Enter)"
                                className={findButton}
                            >
                                <ChevronDown className="size-3.5" aria-hidden />
                            </button>
                            {!server && (
                                <button
                                    onClick={() => setOnlyMatches(!onlyMatches)}
                                    aria-pressed={onlyMatches}
                                    title="Show only rows with a match"
                                    className={cn(findButton, 'w-auto gap-1 px-1.5', onlyMatches && 'bg-primary-soft text-primary-text')}
                                >
                                    <Filter className="size-3.5" aria-hidden />
                                    Only matches
                                </button>
                            )}
                            <button onClick={closeFind} aria-label="Close find" title="Close (Esc)" className={findButton}>
                                <X className="size-3.5" aria-hidden />
                            </button>
                        </div>
                    )}

                    {partial && (
                        <span className="pointer-events-none absolute bottom-3 left-16 rounded-md bg-elev px-2.5 py-1 text-xs text-fg2 ring-1 ring-border">
                            {filters.length || onlyMatches ? 'Filtered' : 'Sorted'} within the {output.rows.length.toLocaleString()} loaded rows
                        </span>
                    )}
                    <span
                        role="status"
                        className={cn(
                            'pointer-events-none absolute right-3 bottom-3 rounded-md bg-elev px-2.5 py-1 text-xs text-fg2 tabular-nums ring-1 ring-border transition-opacity',
                            status ? 'opacity-100' : 'opacity-0',
                        )}
                    >
                        {status}
                    </span>
                </div>
                {previewing && selected && (
                    <ValuePanel
                        column={output.columns[selected.col]}
                        row={selected.row + 1}
                        value={valueAt(selected.row, selected.col)}
                        onClose={() => {
                            setPreviewing(false);
                            scrollRef.current?.focus();
                        }}
                    />
                )}
            </div>
        </Popover>
    );
}
