import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { commands, type DetailColumn, type ResultColumn, type TableDetails } from '@/bindings';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { errorMessage, type Connection } from '@/stores/connections';
import { useUi, type Inspected } from '@/stores/ui';
import { filterKindOf } from '@/lib/column-filter';
import { dateParts, labelColumnOf, withDay, withTime } from '@/lib/cell-field';
import { detailsOf, tableKey } from '@/lib/table-details';
import { cn } from '@/lib/utils';
import { calendarClass, calendarClassNames, fromDay, toDay, withSeconds } from './ColumnFilterForm';

type Option = { value: string | null; label?: string | null };

/** How a column's cells are edited: picked from a list, a calendar or the rows it points at, or typed */
export type CellField = {
    /** False for NOT NULL: nothing stages NULL into it */
    nullable: boolean;
    type: 'text' | 'number' | 'date' | 'datetime' | 'choice' | 'ref';
    /** Why the column can't be edited here, when it can't */
    readOnly?: string;
    /** A choice's values (an enum's labels; true and false as the database writes them) */
    options?: Option[];
    /** A foreign key's target */
    ref?: Inspected & { column: string };
};

/** The editor for a table column, from the table's details where known */
export function fieldOf(
    column: ResultColumn,
    detail: DetailColumn | undefined,
    engine: Connection['kind'] | undefined,
    at: Pick<Inspected, 'connectionId' | 'database'>,
): CellField {
    const nullable = detail?.nullable ?? true;
    // Binary values come back as \x… text, which would be written back as that text
    if (column.kind === 'binary') return { nullable, type: 'text', readOnly: 'Read-only: binary values can’t be edited here' };
    if (detail?.references && detail.referencesColumn) {
        const schema = detail.referencesSchema ?? '';
        // MySQL's schemas are its databases
        const database = engine === 'mysql' ? schema : at.database;
        return {
            nullable,
            type: 'ref',
            ref: { connectionId: at.connectionId, database, schema, table: detail.references, column: detail.referencesColumn },
        };
    }
    if (detail?.enumValues?.length) return { nullable, type: 'choice', options: detail.enumValues.map((value) => ({ value })) };
    // MySQL's BOOLEAN is tinyint(1); only Postgres takes the words, the others store 1 and 0
    if (column.kind === 'bool' || /^tinyint\(1\)/i.test(detail?.typeName ?? '')) {
        const [t, f] = engine === 'postgres' ? ['true', 'false'] : ['1', '0'];
        return {
            nullable,
            type: 'choice',
            options: [
                { value: t, label: 'true' },
                { value: f, label: 'false' },
            ],
        };
    }
    return { nullable, type: filterKindOf(column.kind, column.typeName) };
}

/** Each result column's editor, from its table column's type, keys and allowed values; `locked` (the
 * whole table can't be edited) makes every one read-only */
export function useFields(
    columns: ResultColumn[] | undefined,
    details: TableDetails | undefined,
    engine: Connection['kind'] | undefined,
    at: Pick<Inspected, 'connectionId' | 'database'>,
    locked: string | undefined,
) {
    return useMemo(() => {
        const byName = new Map(details?.columns.map((d) => [d.name, d]));
        return columns?.map((c) => {
            const field = fieldOf(c, byName.get(c.name), engine, at);
            return locked ? { ...field, readOnly: locked } : field;
        });
    }, [columns, details, engine, at.connectionId, at.database, locked]);
}

/** Postgres prints a boolean as t or f: the same value as the option that writes it */
const sameValue = (a: string | null, b: string | null) =>
    a === b || (a !== null && b !== null && ({ t: 'true', f: 'false' }[a] ?? a) === ({ t: 'true', f: 'false' }[b] ?? b));

type Done = (to: string | null | undefined, refocus: boolean) => void;

type Props = {
    value: string | null;
    field: CellField;
    /** The new value (undefined when unchanged or cancelled), and whether the grid should take focus back */
    onDone: Done;
    /** The text input's look, which a popover editor's anchor shares */
    className?: string;
};

/** NULL as the grid shows it: a marker, not text */
export function NullMark() {
    return <span className="font-mono text-[11px] text-fg4">NULL</span>;
}

/**
 * Edits one value the way its column takes it. Text and numbers are typed: Enter or leaving keeps it,
 * Escape cancels. The rest open a popover anchored here: picking stages the value, Escape cancels.
 */
export function CellEditor({ value, field, onDone, className }: Props) {
    // Escape unmounts the editor, which can blur it too: only the first ending counts
    const done = useRef(false);
    const finish: Done = (to, refocus) => {
        if (done.current) return;
        done.current = true;
        onDone(to === undefined || sameValue(to, value) ? undefined : to, refocus);
    };
    return (
        // The grid's own keys (arrows, Space, copy) and clicks stay out, the popover's included: React bubbles through portals
        <span
            className="contents"
            onKeyDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
        >
            {field.type === 'text' || field.type === 'number' ? (
                <input
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    inputMode={field.type === 'number' ? 'decimal' : undefined}
                    defaultValue={value ?? ''}
                    placeholder={value === null ? 'NULL' : undefined}
                    aria-label="Cell value"
                    onFocus={(e) => e.target.select()}
                    // Unchanged text stages nothing, so a NULL stays NULL
                    onBlur={(e) => finish(e.target.value === (value ?? '') ? undefined : e.target.value, false)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') finish(e.currentTarget.value === (value ?? '') ? undefined : e.currentTarget.value, true);
                        else if (e.key === 'Escape') finish(undefined, true);
                    }}
                    className={cn('placeholder:text-fg4', className)}
                />
            ) : field.type === 'date' || field.type === 'datetime' ? (
                <DateEditor value={value} field={field} finish={finish} className={className} />
            ) : (
                <PickEditor value={value} field={field} finish={finish} className={className} />
            )}
        </span>
    );
}

/** The value in the cell while a popover edits it, with the popover anchored to it */
function Shell({
    value,
    className,
    label,
    onLeave,
    finish,
    children,
}: {
    value: string | null;
    className?: string;
    label: string;
    /** Clicking elsewhere: a date keeps what was set, a list picks nothing */
    onLeave: () => void;
    finish: Done;
    children: ReactNode;
}) {
    return (
        <Popover open>
            <PopoverAnchor asChild>
                <span className={cn('flex items-center truncate', value === null && 'text-fg4', className)}>{value ?? 'NULL'}</span>
            </PopoverAnchor>
            <PopoverContent
                aria-label={label}
                className="flex w-64 flex-col gap-2 p-2"
                onEscapeKeyDown={() => finish(undefined, true)}
                onInteractOutside={onLeave}
            >
                {children}
            </PopoverContent>
        </Popover>
    );
}

function DateEditor({ value, field, finish, className }: { value: string | null; field: CellField; finish: Done; className?: string }) {
    const timed = field.type === 'datetime';
    const [draft, setDraft] = useState(value ?? '');
    const parts = dateParts(draft);
    const keep = (refocus: boolean) => finish(draft.trim() === '' && value === null ? undefined : draft.trim(), refocus);
    return (
        <Shell value={value} className={className} label="Edit date" onLeave={() => keep(false)} finish={finish}>
            <Input
                autoFocus
                autoComplete="off"
                spellCheck={false}
                aria-label={timed ? 'Date and time' : 'Date'}
                placeholder={timed ? 'YYYY-MM-DD HH:MM:SS' : 'YYYY-MM-DD'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && keep(true)}
                className="h-7 font-mono text-xs"
            />
            <Calendar
                mode="single"
                selected={parts && fromDay(parts.day)}
                defaultMonth={parts && fromDay(parts.day)}
                onSelect={(d) => {
                    if (!d) return;
                    const next = withDay(draft, toDay(d), timed);
                    // A day is the whole value of a date: picking it is the edit
                    if (timed) setDraft(next);
                    else finish(next, true);
                }}
                className={calendarClass}
                classNames={calendarClassNames}
            />
            <div className="flex items-center gap-1.5">
                {timed && (
                    <Input
                        type="time"
                        step={1}
                        aria-label="Time"
                        disabled={!parts}
                        value={parts?.time ? withSeconds(parts.time) : ''}
                        onChange={(e) => e.target.value && setDraft(withTime(draft, withSeconds(e.target.value)))}
                        className="h-7 w-32 px-2 font-mono text-[11px]"
                    />
                )}
                {field.nullable && (
                    <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => finish(null, true)}>
                        Set NULL
                    </Button>
                )}
                {timed && (
                    <Button type="button" size="sm" className={cn(!field.nullable && 'ml-auto')} onClick={() => keep(true)}>
                        Done
                    </Button>
                )}
            </div>
        </Shell>
    );
}

const LIMIT = 50;

/** A foreign key's choices: matching rows of the table it points at, key and label. The label is
 * the columns the user chose for that table (remembered), else the app's pick (`labelColumnOf`) */
function useLookup(field: CellField, value: string | null, search: string) {
    const ref = field.ref;
    const table = ref ? tableKey(ref) : '';
    const chosen = useUi((s) => s.lookupLabels[table]);
    // The referenced table's columns, and the app's own pick among them
    const [columns, setColumns] = useState<{ all: string[]; auto: string[] } | null>(null);
    const [rows, setRows] = useState<{ for: string; options: Option[] } | null>(null);
    const [current, setCurrent] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const labels = columns ? (chosen ?? columns.auto) : null;
    // Per editor and label: going back to an earlier search shows its rows without reading them again
    const cache = useRef(new Map<string, Option[]>());
    const labelKey = labels?.join('\0') ?? '';

    const read = (text: string) =>
        commands.lookupRows(ref!.connectionId, {
            database: ref!.database || null,
            schema: ref!.schema,
            table: ref!.table,
            keyColumn: ref!.column,
            labelColumns: labels ?? [],
            search: text,
            limit: LIMIT,
        });

    useEffect(() => {
        if (!ref) return;
        let live = true;
        detailsOf(ref).then(
            (d) => {
                if (!live) return;
                const auto = labelColumnOf(d.columns, ref.column);
                setColumns({ all: d.columns.map((c) => c.name).filter((c) => c !== ref.column), auto: auto ? [auto] : [] });
            },
            () => live && setColumns({ all: [], auto: [] }),
        );
        return () => {
            live = false;
        };
        // Once per editor
    }, []);

    // The current value's label, again whenever the label columns change
    useEffect(() => {
        if (!ref || !labels) return;
        cache.current.clear();
        setCurrent(null);
        if (!labels.length || value === null) return;
        let live = true;
        void read(value).then(
            (found) => live && setCurrent(found.find(([k]) => k === value)?.[1] ?? null),
            () => {},
        );
        return () => {
            live = false;
        };
    }, [labelKey]);

    useEffect(() => {
        if (!ref || !labels) return;
        const hit = cache.current.get(search);
        if (hit) {
            setRows({ for: search, options: hit });
            return;
        }
        // Each lookup is audited: wait for a pause in typing
        const timer = setTimeout(
            () =>
                read(search).then(
                    (found) => {
                        const options = found.map(([key, name]) => ({ value: key, label: name }));
                        cache.current.set(search, options);
                        setRows({ for: search, options });
                        setError(null);
                    },
                    (e: unknown) => setError(errorMessage(e)),
                ),
            search ? 250 : 0,
        );
        return () => clearTimeout(timer);
    }, [labelKey, search]);

    const choose = (next: string[] | null) => useUi.getState().setLookupLabels(table, next);
    return {
        rows: rows?.options,
        stale: rows?.for !== search,
        current,
        labelled: !!labels?.length,
        error,
        /** The label columns now, every column that could be one, whether they're the app's pick */
        labels: labels ?? [],
        columns: columns?.all ?? [],
        automatic: !chosen,
        choose,
    };
}

/** Which columns name each row of the referenced table: tick any, in the order they should read */
function LabelPicker({ lookup }: { lookup: ReturnType<typeof useLookup> }) {
    const [open, setOpen] = useState(false);
    const { labels, columns, automatic, choose } = lookup;
    if (!columns.length) return null;
    const toggle = (c: string) => choose(labels.includes(c) ? labels.filter((l) => l !== c) : [...labels, c]);
    return (
        <div className="text-[11px]">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                className="flex max-w-full items-center gap-1 rounded text-fg3 outline-none hover:text-fg2 focus-visible:ring-2 focus-visible:ring-ring/50"
                title="Choose which columns name each row"
            >
                <span className="flex-none">Label:</span>
                <span className="truncate font-mono text-fg2">{labels.length ? labels.join(' · ') : 'id only'}</span>
                {automatic && <span className="flex-none text-fg4">(automatic)</span>}
                <ChevronDown className={cn('size-3 flex-none transition-transform', open && 'rotate-180')} aria-hidden />
            </button>
            {open && (
                <div role="group" aria-label="Label columns" className="mt-1 max-h-36 overflow-auto rounded-md border border-border-soft p-1">
                    {columns.map((c) => {
                        const at = labels.indexOf(c);
                        return (
                            <button
                                key={c}
                                type="button"
                                role="menuitemcheckbox"
                                aria-checked={at >= 0}
                                onClick={() => toggle(c)}
                                className="group/label flex w-full items-center gap-2 rounded px-1.5 py-1 text-left outline-none hover:bg-hover focus-visible:bg-hover"
                            >
                                <span
                                    aria-hidden
                                    className={cn(
                                        'grid size-3.5 flex-none place-items-center rounded-sm border text-[9px] tabular-nums transition-[background-color,border-color,scale] duration-200 group-active/label:scale-85',
                                        at >= 0 ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                                    )}
                                >
                                    {at >= 0 ? at + 1 : ''}
                                </span>
                                <span className="truncate font-mono">{c}</span>
                            </button>
                        );
                    })}
                    {!automatic && (
                        <button
                            type="button"
                            onClick={() => choose(null)}
                            className="mt-1 w-full rounded px-1.5 py-1 text-left text-fg3 outline-none hover:bg-hover hover:text-fg2 focus-visible:bg-hover"
                        >
                            Automatic
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/** Enum values, true or false, or a foreign key's rows: a searchable list. ↑↓ move, Enter or a click picks */
function PickEditor({ value, field, finish, className }: { value: string | null; field: CellField; finish: Done; className?: string }) {
    const ref = field.ref;
    const [search, setSearch] = useState('');
    const lookup = useLookup(field, value, ref ? search.trim() : '');
    const listId = useId();

    const choices = ref
        ? (lookup.rows ?? [])
        : (field.options ?? []).filter((o) => !search || (o.label ?? o.value)!.toLowerCase().includes(search.toLowerCase()));
    const options: Option[] = field.nullable && !search ? [...choices, { value: null }] : choices;
    const [active, setActive] = useState(() =>
        Math.max(
            0,
            options.findIndex((o) => sameValue(o.value, value)),
        ),
    );
    const at = Math.min(active, options.length - 1);
    const searchable = !!ref || options.length > 8;

    const move = (key: string) => {
        if (key === 'ArrowDown') setActive(Math.min(at + 1, options.length - 1));
        else if (key === 'ArrowUp') setActive(Math.max(at - 1, 0));
        else if (key === 'Enter' && options[at]) finish(options[at].value, true);
        else return false;
        return true;
    };
    const optionId = (i: number) => `${listId}-${i}`;

    return (
        <Shell
            value={value}
            className={className}
            label={ref ? `Pick a row of ${ref.table}` : 'Pick a value'}
            onLeave={() => finish(undefined, false)}
            finish={finish}
        >
            {ref && value !== null && (
                <p className="truncate text-[11px] text-fg3">
                    Now <span className="font-mono text-fg2">{value}</span>
                    {lookup.current && <> · {lookup.current}</>}
                </p>
            )}
            {ref && <LabelPicker lookup={lookup} />}
            {searchable && (
                <Input
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    role="combobox"
                    aria-expanded
                    aria-controls={listId}
                    aria-activedescendant={options[at] ? optionId(at) : undefined}
                    aria-label={ref ? `Search ${ref.table}` : 'Search values'}
                    placeholder={ref ? (lookup.labelled ? 'Search by name or id…' : 'Search by id…') : 'Search…'}
                    value={search}
                    onChange={(e) => {
                        setSearch(e.target.value);
                        setActive(0);
                    }}
                    onKeyDown={(e) => move(e.key) && e.preventDefault()}
                    className="h-7 text-xs"
                />
            )}
            <ul
                id={listId}
                role="listbox"
                aria-label="Values"
                // Without a search box the list itself takes the keys (and the popover's first focus)
                tabIndex={searchable ? -1 : 0}
                aria-activedescendant={!searchable && options[at] ? optionId(at) : undefined}
                onKeyDown={(e) => move(e.key) && e.preventDefault()}
                className={cn(
                    '-mx-1 max-h-60 overflow-auto rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    ref && lookup.stale && 'opacity-60',
                )}
            >
                {options.map((o, i) => (
                    <li
                        key={o.value ?? '\0null'}
                        id={optionId(i)}
                        role="option"
                        aria-selected={i === at}
                        onMouseMove={() => i !== at && setActive(i)}
                        onClick={() => finish(o.value, true)}
                        className={cn(
                            'flex cursor-default items-baseline gap-2 rounded px-2 py-1 text-xs',
                            i === at && 'bg-primary-soft',
                            sameValue(o.value, value) && 'font-medium',
                        )}
                    >
                        {o.value === null ? (
                            <NullMark />
                        ) : ref ? (
                            <>
                                <span className="flex-none font-mono text-fg2 tabular-nums">{o.value}</span>
                                {o.label != null && <span className="min-w-0 truncate">{o.label}</span>}
                            </>
                        ) : (
                            <span className="min-w-0 truncate">{o.label ?? o.value}</span>
                        )}
                    </li>
                ))}
                {ref && !lookup.rows && !lookup.error && <li className="px-2 py-1 text-xs text-fg3">Loading…</li>}
                {ref && lookup.rows && !lookup.rows.length && !lookup.stale && <li className="px-2 py-1 text-xs text-fg3">No matching rows</li>}
                {!ref && !choices.length && <li className="px-2 py-1 text-xs text-fg3">No matching values</li>}
            </ul>
            {lookup.error && (
                <p role="alert" className="text-[11px] wrap-anywhere text-danger">
                    {lookup.error}
                </p>
            )}
            {ref && lookup.rows?.length === LIMIT && <p className="text-[11px] text-fg4">First {LIMIT} shown: type to narrow</p>}
        </Shell>
    );
}
