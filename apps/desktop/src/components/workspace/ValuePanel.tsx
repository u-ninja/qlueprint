import { useMemo, useState, type ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { useCopy } from '@/lib/use-copy';
import type { ResultColumn } from '@/bindings';
import { cn, count } from '@/lib/utils';
import { NullMark } from './CellEditor';

// Past this, highlighting every token of pretty-printed JSON costs more than it's worth: shown plain
const HIGHLIGHT_LIMIT = 200_000;

/** The value as JSON when it is an object or array (a JSON column, or text that holds one) */
function asJson(value: string): unknown {
    const start = value.trimStart()[0];
    if (start !== '{' && start !== '[') return undefined;
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

// Keys, strings, numbers, true/false/null and punctuation, in the order they appear
const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;

/** Pretty JSON, colored with the editor's syntax tokens so it reads like the SQL above it */
function JsonView({ text }: { text: string }) {
    if (text.length > HIGHLIGHT_LIMIT) return <>{text}</>;
    const parts: ReactNode[] = [];
    let last = 0;
    for (const m of text.matchAll(JSON_TOKEN)) {
        const i = m.index;
        if (i > last) parts.push(text.slice(last, i));
        const [whole, str, colon, num, word] = m;
        const color = str
            ? colon
                ? 'text-[var(--syn-kw)]'
                : 'text-[var(--syn-str)]'
            : num
              ? 'text-[var(--syn-num)]'
              : word
                ? 'text-[var(--syn-fn)]'
                : 'text-fg4';
        parts.push(
            <span key={i} className={color}>
                {str ?? whole}
            </span>,
        );
        if (colon) parts.push(colon);
        last = i + whole.length;
    }
    parts.push(text.slice(last));
    return <>{parts}</>;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000_000],
    ['month', 2_592_000_000],
    ['week', 604_800_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
    ['second', 1000],
];

/** "Monday, 12 October 2026 at 08:47:12 · 4 weeks ago", when the driver's text parses as a date */
function readableDate(value: string) {
    // Drivers print "2026-10-12 08:47:12.123"; Date wants a T between date and time
    const date = new Date(/^\d{4}-\d{2}-\d{2} /.test(value) ? value.replace(' ', 'T') : value);
    if (Number.isNaN(date.getTime())) return undefined;
    const diff = date.getTime() - Date.now();
    const [unit, ms] = units.find(([, ms]) => Math.abs(diff) >= ms) ?? units[units.length - 1];
    return `${dateTime.format(date)} · ${relative.format(Math.round(diff / ms), unit)}`;
}

type Props = { column: ResultColumn; row: number; value: string | null; onClose: () => void };

/** The selected cell's whole value, shown for what it is: JSON formatted, dates readable, long text wrapped */
export function ValuePanel({ column, row, value, onClose }: Props) {
    const json = useMemo(() => (value === null ? undefined : asJson(value)), [value]);
    const [raw, setRaw] = useState(false);
    const [copied, copyText] = useCopy();
    const pretty = json !== undefined && !raw ? JSON.stringify(json, null, 2) : null;
    const date = column.kind === 'temporal' && value !== null ? readableDate(value) : undefined;
    const number = column.kind === 'number' && value !== null && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined;

    const copy = () => copyText(pretty ?? value);
    const toggle = 'rounded px-1.5 py-0.5 text-[11px] hover:bg-hover hover:text-foreground aria-pressed:bg-hover aria-pressed:text-foreground';
    const icon = 'grid size-6 flex-none place-items-center rounded text-fg3 hover:bg-hover hover:text-foreground';

    return (
        <aside
            aria-label={`Value of ${column.name}, row ${row}`}
            className="flex h-full w-[340px] flex-none flex-col border-l border-border-soft bg-surface"
        >
            <header className="flex h-9 flex-none items-center gap-2 border-b border-border-soft pr-1.5 pl-3 text-xs">
                <span className="min-w-0 truncate font-medium" title={column.name}>
                    {column.name}
                </span>
                <span className="flex-none font-mono text-[10.5px] text-fg4">{column.typeName.toLowerCase()}</span>
                <span className="flex-none font-mono text-[10.5px] text-fg4 tabular-nums">row {row.toLocaleString()}</span>
                <span className="ml-auto flex items-center gap-0.5">
                    {json !== undefined && (
                        <span role="group" aria-label="View as" className="mr-1 flex text-fg3">
                            <button aria-pressed={!raw} onClick={() => setRaw(false)} className={toggle}>
                                JSON
                            </button>
                            <button aria-pressed={raw} onClick={() => setRaw(true)} className={toggle}>
                                Raw
                            </button>
                        </span>
                    )}
                    <button
                        onClick={copy}
                        disabled={value === null}
                        aria-label="Copy value"
                        title="Copy value"
                        className={cn(icon, 'disabled:opacity-40')}
                    >
                        {copied ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                    </button>
                    <button onClick={onClose} aria-label="Close value panel" title="Close (Esc)" className={icon}>
                        <X className="size-3.5" aria-hidden />
                    </button>
                </span>
            </header>

            {/* What the raw text means, when it isn't obvious from it */}
            {(date || number !== undefined || column.kind === 'binary') && value !== null && (
                <p className="flex-none border-b border-border-soft px-3 py-2 text-xs text-fg2">
                    {date ??
                        (number !== undefined
                            ? number.toLocaleString(undefined, { maximumFractionDigits: 20 })
                            : `${count(value.length, 'character')} as stored`)}
                </p>
            )}

            <div className="min-h-0 flex-1 overflow-auto p-3 select-text">
                {value === null ? (
                    <NullMark />
                ) : (
                    <pre className={cn('font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap', !pretty && 'text-foreground')}>
                        {pretty ? <JsonView text={pretty} /> : value || <span className="text-fg4">(empty string)</span>}
                    </pre>
                )}
            </div>

            {value !== null && (
                <footer className="flex h-6 flex-none items-center gap-3 border-t border-border-soft px-3 font-mono text-[11px] text-fg4 tabular-nums">
                    <span>{count(value.length, 'character')}</span>
                    <span>{count(value.split('\n').length, 'line')}</span>
                </footer>
            )}
        </aside>
    );
}
