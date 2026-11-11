import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { arity, opsFor, type ColumnFilter, type FilterKind, type FilterOp } from '@/lib/column-filter';

/** A local calendar day as YYYY-MM-DD, and back */
export const toDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const fromDay = (day: string) => {
    const [y, m, d] = day.split('-').map(Number);
    return y ? new Date(y, m - 1, d) : undefined;
};
/** <input type="time"> gives HH:MM when the seconds are zero */
export const withSeconds = (time: string) => (time.length === 5 ? `${time}:00` : time);

// Compact: 24px days in small type, so the calendar fits a filter box instead of filling it
// shadcn's calendar paints bg-background and only clears it inside a shadcn popover: cleared here so it
// sits on whatever surface holds it. 28px days (shadcn's own size) with 12px numbers, so they don't crowd
export const calendarClass = 'self-center bg-transparent p-0 [--cell-size:--spacing(7)]';
export const calendarClassNames = {
    month: 'flex w-full flex-col gap-2',
    caption_label: 'text-xs font-medium select-none',
    weekday: 'flex-1 text-[11px] font-normal text-muted-foreground select-none',
    week: 'mt-1 flex w-full',
    day_button: 'text-xs',
};

const longDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const show = (day: string) => (day ? longDay.format(fromDay(day)) : '…');

type Props = {
    column: string;
    kind: FilterKind;
    /** The column's current filter, to edit it */
    initial?: ColumnFilter;
    onApply: (filter: ColumnFilter) => void;
    onClear?: () => void;
};

/**
 * One column's filter: a condition, then its value. Dates pick from a calendar (a range for "between"),
 * date-times add a time of day, numbers and text type theirs.
 */
export function ColumnFilterForm({ column, kind, initial, onApply, onClear }: Props) {
    const dated = kind === 'date' || kind === 'datetime';
    const [op, setOp] = useState<FilterOp>(initial?.op ?? (dated ? 'between' : kind === 'text' ? 'contains' : '='));
    const n = arity(op);

    // Text and numbers: the values as typed
    const [value, setValue] = useState(initial?.value ?? '');
    const [value2, setValue2] = useState(initial?.value2 ?? '');
    // Dates: the day and, for date-times, the time of each end ("between" defaults to the whole of both days)
    const [day, time] = (initial?.value ?? '').split(' ');
    const [day2, time2] = (initial?.value2 ?? '').split(' ');
    const [from, setFrom] = useState(day ?? '');
    const [to, setTo] = useState(day2 ?? '');
    const [fromTime, setFromTime] = useState(time ?? '00:00:00');
    const [toTime, setToTime] = useState(time2 ?? '23:59:59');
    // "on" means the whole day, so it takes no time
    const timed = kind === 'datetime' && op !== '=';

    const values: [string, string] = dated
        ? [timed && from ? `${from} ${withSeconds(fromTime)}` : from, timed && to ? `${to} ${withSeconds(toTime)}` : to]
        : [value.trim(), value2.trim()];
    const complete = (n < 1 || values[0] !== '') && (n < 2 || values[1] !== '');
    const backwards = n === 2 && complete && (kind === 'number' ? Number(values[0]) > Number(values[1]) : values[0] > values[1]);

    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (complete && !backwards) onApply({ column, kind, op, ...(n > 0 && { value: values[0] }), ...(n > 1 && { value2: values[1] }) });
    };

    const field = (label: string, v: string, set: (v: string) => void, autoFocus = false) => (
        <Input
            autoComplete="off"
            type={kind === 'number' ? 'number' : 'text'}
            value={v}
            onChange={(e) => set(e.target.value)}
            aria-label={label}
            placeholder={kind === 'text' ? 'Value…' : undefined}
            autoFocus={autoFocus}
            spellCheck={false}
            className="h-8 font-mono text-xs"
        />
    );
    const timeField = (label: string, v: string, set: (v: string) => void) => (
        <Input
            autoComplete="off"
            type="time"
            step={1}
            value={v}
            onChange={(e) => set(e.target.value)}
            aria-label={label}
            className="h-7 w-32 px-2 font-mono text-[11px]"
        />
    );

    return (
        <form onSubmit={submit} className="flex flex-col gap-2">
            <p className="text-xs text-fg3">
                Filter <span className="font-mono text-foreground">{column}</span>
            </p>
            <Select value={op} onValueChange={(v) => setOp(v as FilterOp)}>
                <SelectTrigger size="sm" aria-label="Condition" className="w-full">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                    {opsFor[kind].map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                            {label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {!dated && n === 1 && field('Value', value, setValue, true)}
            {!dated && n === 2 && (
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
                    {field('From', value, setValue, true)}
                    <span className="text-xs text-fg4">to</span>
                    {field('To', value2, setValue2)}
                </div>
            )}

            {dated && n > 0 && (
                <>
                    {n === 1 ? (
                        <Calendar
                            mode="single"
                            selected={fromDay(from)}
                            onSelect={(d) => setFrom(d ? toDay(d) : '')}
                            defaultMonth={fromDay(from)}
                            className={calendarClass}
                            classNames={calendarClassNames}
                        />
                    ) : (
                        <Calendar
                            mode="range"
                            selected={{ from: fromDay(from), to: fromDay(to) }}
                            onSelect={(range) => {
                                setFrom(range?.from ? toDay(range.from) : '');
                                setTo(range?.to ? toDay(range.to) : '');
                            }}
                            defaultMonth={fromDay(from)}
                            className={calendarClass}
                            classNames={calendarClassNames}
                        />
                    )}
                    {/* The picked days in words, and their times for a date-time column */}
                    {n === 1 ? (
                        <div className="grid grid-cols-[1fr_auto] items-center gap-1.5">
                            <span className="text-xs text-fg2">{show(from)}</span>
                            {timed && timeField('Time', fromTime, setFromTime)}
                        </div>
                    ) : (
                        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1.5 text-xs">
                            <span className="text-fg4">From</span>
                            <span className="text-fg2">{show(from)}</span>
                            {timed ? timeField('From time', fromTime, setFromTime) : <span />}
                            <span className="text-fg4">To</span>
                            <span className="text-fg2">{show(to)}</span>
                            {timed ? timeField('To time', toTime, setToTime) : <span />}
                        </div>
                    )}
                    {n === 2 && !timed && <p className="text-[11px] text-fg4">Both days included</p>}
                </>
            )}

            {backwards && (
                <p role="alert" className="text-[11px] text-danger">
                    The start comes after the end.
                </p>
            )}
            <div className="flex justify-end gap-1.5 pt-0.5">
                {onClear && (
                    <Button type="button" variant="ghost" size="sm" onClick={onClear}>
                        Clear
                    </Button>
                )}
                <Button type="submit" size="sm" disabled={!complete || backwards}>
                    Apply
                </Button>
            </div>
        </form>
    );
}
