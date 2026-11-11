import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Braces, CalendarDays, Columns3, ListFilter, Quote, X } from 'lucide-react';
import type { ColumnInfo } from '@/bindings';
import { useConnections, type Connection } from '@/stores/connections';
import { useQuery, type TableTab } from '@/stores/query';
import { literal, sqlValue } from '@/lib/sql-quote';
import { columnsOf, sqlName } from '@/lib/columns';
import { suggestWhere, type SuggestColumn, type Suggestion } from '@/lib/where-suggest';
import { cn } from '@/lib/utils';
import { filterKindOf } from '@/lib/column-filter';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { calendarClass, calendarClassNames, fromDay, toDay, withSeconds } from './ColumnFilterForm';

/** A column's calendar kind: DATE picks a day, DATETIME and TIMESTAMP a day and a time, others none */
function dateKind(kind: string, typeName: string) {
    const k = filterKindOf(kind, typeName);
    return k === 'date' || k === 'datetime' ? k : undefined;
}

const NUMERIC = /int|numeric|decimal|real|double|float|serial|money|number/i;
const icons = { column: Columns3, operator: Braces, value: Quote, keyword: Braces, picker: CalendarDays };

/** Distinct values of a column in the loaded rows, most frequent first, as SQL literals */
function sampleValues(tab: TableTab, column: string, numeric: boolean, kind: Connection['kind'] | undefined) {
    if (!tab.outcome?.ok) return [];
    const { columns, rows } = tab.outcome.output;
    const index = columns.findIndex((c) => c.name === column);
    if (index < 0) return [];
    const counts = new Map<string, number>();
    for (const row of rows) {
        const value = row[index];
        if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .map(([v]) => sqlValue(v, numeric, kind));
}

/**
 * The table tab's WHERE box. Typed SQL is a draft until Enter, so a half-written condition never runs.
 * Suggests as you type: the table's columns, then operators, then values seen in the loaded rows, then AND / OR.
 */
export function WhereBar({ tab: t }: { tab: TableTab }) {
    const queryTable = useQuery((s) => s.queryTable);
    const kind = useConnections((s) => s.connections.find((c) => c.id === t.connectionId)?.kind);
    const [draft, setDraft] = useState(t.where);
    const [caret, setCaret] = useState(t.where.length);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(-1);
    const [info, setInfo] = useState<ColumnInfo[]>([]);
    const inputRef = useRef<HTMLInputElement>(null);
    const listId = useId();

    // A filter set elsewhere (a cell's menu, the status bar's clear) replaces the draft
    useEffect(() => setDraft(t.where), [t.where]);

    // The table's columns from the database: known even when the current filter failed and no rows came back
    useEffect(() => {
        let live = true;
        columnsOf(t.connectionId, t.database).then(
            (all) => live && setInfo(all.filter((c) => c.schema === t.schema && c.table === t.table)),
            () => {},
        );
        return () => {
            live = false;
        };
    }, [t.connectionId, t.database, t.schema, t.table]);

    const columns = useMemo<SuggestColumn[]>(() => {
        const loaded = t.outcome?.ok ? t.outcome.output.columns : [];
        if (info.length)
            return info.map((c) => ({
                name: c.name,
                typeName: c.typeName,
                numeric: NUMERIC.test(c.typeName),
                // The catalog gives only the type's name: anything with a date or time in it is temporal
                date: dateKind(/date|time/i.test(c.typeName) ? 'temporal' : '', c.typeName),
            }));
        return loaded.map((c) => ({
            name: c.name,
            typeName: c.typeName.toLowerCase(),
            numeric: c.kind === 'number',
            date: dateKind(c.kind, c.typeName),
        }));
    }, [info, t.outcome]);

    const { from, items } = useMemo(
        () =>
            kind
                ? suggestWhere(draft, caret, columns, {
                      postgres: kind === 'postgres',
                      quote: (name) => sqlName(kind, name),
                      values: (name) => sampleValues(t, name, columns.find((c) => c.name === name)?.numeric ?? false, kind),
                  })
                : { from: caret, items: [] },
        [draft, caret, columns, kind, t],
    );
    const shown = open && items.length > 0;
    const showingValues = shown && items[0].kind === 'value';
    // Nothing typed yet: Enter still applies the filter, so nothing is pre-selected
    const typing = caret > from;
    const current = active >= 0 ? Math.min(active, items.length - 1) : typing ? 0 : -1;

    const apply = (where: string) => {
        setOpen(false);
        void queryTable(t.id, { where });
    };

    // "Pick a date…" turns the list into a calendar for that column's kind
    const [picking, setPicking] = useState<{ kind: 'date' | 'datetime'; range: boolean } | null>(null);
    const [day, setDay] = useState('');
    const [time, setTime] = useState('00:00:00');
    // A range's end: the whole of its last day unless a time is set
    const [day2, setDay2] = useState('');
    const [time2, setTime2] = useState('23:59:59');

    const insert = (text: string) => {
        const next = draft.slice(0, from) + text + draft.slice(caret);
        const at = from + text.length;
        setDraft(next);
        setCaret(at);
        setActive(-1);
        setOpen(true);
        requestAnimationFrame(() => {
            inputRef.current?.focus();
            inputRef.current?.setSelectionRange(at, at);
        });
    };
    const stamp = (d: string, t: string) => literal(picking?.kind === 'datetime' ? `${d} ${withSeconds(t)}` : d, kind);
    const pickedAll = !!day && (!picking?.range || !!day2);
    const insertPicked = () => {
        if (!pickedAll) return;
        insert(picking?.range ? `${stamp(day, time)} AND ${stamp(day2, time2)} ` : `${stamp(day, time)} `);
        setPicking(null);
    };

    const timeField = (label: string, v: string, set: (v: string) => void) => (
        <Input
            type="time"
            step={1}
            value={v}
            onChange={(e) => set(e.target.value)}
            onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                insertPicked();
            }}
            aria-label={label}
            className="h-7 w-32 px-2 font-mono text-[11px]"
        />
    );

    const accept = (item: Suggestion) => {
        if (item.kind === 'picker') {
            setPicking({ kind: columns.find((c) => c.name === item.detail)?.date ?? 'date', range: !!item.range });
            setDay('');
            setDay2('');
            return;
        }
        const next = draft.slice(0, from) + item.insert + draft.slice(caret);
        const at = from + item.insert.length;
        setDraft(next);
        setCaret(at);
        setActive(-1);
        // Stay open: the next step's suggestions (operator, value, AND) follow straight away
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.setSelectionRange(at, at));
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        // The calendar is open: focus stays here, so its keys arrive here too
        if (picking && (e.key === 'Enter' || e.key === 'Escape')) {
            e.preventDefault();
            if (e.key === 'Enter') insertPicked();
            else setPicking(null);
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            if (items.length) setActive((current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
        } else if ((e.key === 'Enter' || e.key === 'Tab') && shown && (current >= 0 || e.key === 'Tab')) {
            e.preventDefault();
            accept(items[Math.max(current, 0)]);
        } else if (e.key === ' ' && e.ctrlKey) {
            e.preventDefault();
            setOpen(true);
        } else if (e.key === 'Escape') {
            if (shown) setOpen(false);
            else setDraft(t.where);
        }
    };

    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                apply(draft);
            }}
            // Focus moving into the dropdown (the calendar, the time field) keeps it open; leaving the box closes it
            onBlur={(e) => {
                if (e.currentTarget.contains(e.relatedTarget)) return;
                setOpen(false);
                setPicking(null);
            }}
            // The input itself has no outline: the whole box shows focus, so the WHERE label lights up with it
            className="relative -mx-1.5 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 has-[input:focus-visible]:ring-1 has-[input:focus-visible]:ring-ring/50"
        >
            <ListFilter className={cn('size-3.5 flex-none', t.where ? 'text-primary-text' : 'text-fg4')} aria-hidden />
            <span className="flex-none font-mono text-[11px] text-fg4">WHERE</span>
            <input
                ref={inputRef}
                autoComplete="off"
                value={draft}
                onChange={(e) => {
                    setDraft(e.target.value);
                    setCaret(e.target.selectionStart ?? e.target.value.length);
                    setActive(-1);
                    setOpen(true);
                }}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
                onFocus={() => setOpen(true)}

                onKeyDown={onKeyDown}
                placeholder={columns.length ? `${columns[0].name} = …   start typing for columns` : "status = 'active'"}
                role="combobox"
                aria-expanded={shown}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={shown && current >= 0 ? `${listId}-${current}` : undefined}
                aria-label="Filter rows with a SQL condition. Suggestions appear as you type; Enter applies, Escape reverts"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-fg4"
            />
            {draft !== t.where && !shown && <span className="flex-none text-[11px] text-fg4">Enter to apply</span>}
            {(t.where || draft) && (
                <button
                    type="button"
                    onClick={() => (t.where ? apply('') : setDraft(''))}
                    aria-label="Clear filter"
                    title="Clear filter"
                    className="grid size-5 flex-none place-items-center rounded text-fg3 hover:bg-hover hover:text-foreground"
                >
                    <X className="size-3.5" aria-hidden />
                </button>
            )}

            {open && picking && (
                <div
                    role="dialog"
                    aria-label={picking.range ? 'Pick a date range' : picking.kind === 'datetime' ? 'Pick a date and time' : 'Pick a date'}
                    onKeyDown={(e) => {
                        if (e.key !== 'Escape') return;
                        e.preventDefault();
                        setPicking(null);
                        inputRef.current?.focus();
                    }}
                    // WebKit doesn't focus a clicked button, so a click here would blur the box with nowhere to go
                    // and close the picker first. Keep focus where it is, except for the time fields, which need it
                    onMouseDown={(e) => {
                        if (!(e.target as HTMLElement).closest('input')) e.preventDefault();
                    }}
                    className="absolute top-full left-20 z-50 mt-1.5 flex w-64 flex-col gap-2 rounded-lg bg-popover p-2.5 text-popover-foreground shadow-md ring-1 ring-foreground/10"
                >
                    {picking.range ? (
                        <Calendar
                            mode="range"
                            selected={{ from: fromDay(day), to: fromDay(day2) }}
                            onSelect={(r) => {
                                setDay(r?.from ? toDay(r.from) : '');
                                setDay2(r?.to ? toDay(r.to) : '');
                            }}
                            defaultMonth={fromDay(day)}
                            className={calendarClass}
                            classNames={calendarClassNames}
                        />
                    ) : (
                        <Calendar
                            mode="single"
                            selected={fromDay(day)}
                            onSelect={(d) => setDay(d ? toDay(d) : '')}
                            defaultMonth={fromDay(day)}
                            className={calendarClass}
                            classNames={calendarClassNames}
                        />
                    )}
                    {picking.kind === 'datetime' && (
                        <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5 text-xs">
                            <span className="text-fg4">{picking.range ? 'From' : 'Time'}</span>
                            {timeField(picking.range ? 'From time' : 'Time', time, setTime)}
                            {picking.range && (
                                <>
                                    <span className="text-fg4">To</span>
                                    {timeField('To time', time2, setTime2)}
                                </>
                            )}
                        </div>
                    )}
                    <div className="flex items-center gap-1.5">
                        {picking.range && !picking.kind.endsWith('time') && <span className="text-[11px] text-fg4">Both days included</span>}
                        <Button type="button" size="sm" className="ml-auto" disabled={!pickedAll} onClick={insertPicked}>
                            Insert
                        </Button>
                    </div>
                </div>
            )}

            {shown && !picking && (
                <div className="absolute top-full left-20 z-50 mt-1.5 w-80 overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10">
                    <ul id={listId} role="listbox" aria-label="Suggestions" className="max-h-64 overflow-auto p-1">
                        {items.map((item, i) => {
                            const Icon = icons[item.kind];
                            return (
                                <li
                                    key={`${item.kind}:${item.label}`}
                                    id={`${listId}-${i}`}
                                    role="option"
                                    aria-selected={i === current}
                                    // mousedown, not click: the input keeps focus, so the list doesn't close first
                                    onMouseDown={(e) => {
                                        e.preventDefault();
                                        accept(item);
                                    }}
                                    onMouseMove={() => setActive(i)}
                                    className={cn(
                                        'flex cursor-default items-center gap-2 rounded-md px-1.5 py-1 text-xs',
                                        i === current && 'bg-accent text-accent-foreground',
                                    )}
                                >
                                    <Icon className="size-3.5 flex-none text-fg4" aria-hidden />
                                    <span className="min-w-0 truncate font-mono">{item.label}</span>
                                    {item.detail && (
                                        <span className="ml-auto flex-none truncate pl-3 font-mono text-[11px] text-fg4">{item.detail}</span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                    <p className="border-t border-border-soft px-2.5 py-1.5 text-[11px] text-fg4">
                        {showingValues
                            ? `Values from the ${t.outcome?.ok ? t.outcome.output.rows.length.toLocaleString() : 0} loaded rows · or type your own`
                            : '↑↓ to choose · Tab or Enter to insert · Esc to close'}
                    </p>
                </div>
            )}
        </form>
    );
}
