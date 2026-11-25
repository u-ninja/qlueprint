// Pure helpers for the type-aware cell editor; type-only imports keep them runnable on their own
import type { DetailColumn } from '@/bindings';

// Most likely to read as a row's name, in order of preference
const LABELS = ['name', 'title', 'label', 'display_name', 'username', 'code'];
// A row's own reference number or code: `appointment_number`, `po_no`, `invoice_ref`
const IDENTIFIER = /(^|_)(number|no|num|code|ref)$/i;
const TEXT = /char|text|string|clob/i;

/**
 * The column to show beside a referenced row's key, so each row reads differently: a UNIQUE column
 * (any type: it names exactly one row), then a name-like text column, then a reference-number-like
 * one, then `email`, then the first text column; none when there's nothing to show
 */
export function labelColumnOf(columns: DetailColumn[], keyColumn: string) {
    const others = columns.filter((c) => c.name !== keyColumn && c.key !== 'PK' && c.key !== 'FK');
    const texts = others.filter((c) => TEXT.test(c.typeName));
    const named = (list: DetailColumn[]) => LABELS.map((n) => list.find((c) => c.name.toLowerCase() === n)).find(Boolean);
    const unique = others.filter((c) => c.key === 'UQ');
    return (
        named(unique) ??
        unique[0] ??
        named(texts) ??
        others.find((c) => IDENTIFIER.test(c.name)) ??
        texts.find((c) => c.name.toLowerCase() === 'email') ??
        texts[0]
    )?.name;
}

// `2026-01-31`, `2026-01-31 09:05:00`, `2026-01-31T09:05:00.123+05:30`: the day, separator, time and what follows it
const DATED = /^(\d{4}-\d{2}-\d{2})(?:([ T])(\d{2}:\d{2}(?::\d{2})?)(.*))?$/;

export function dateParts(value: string) {
    const m = DATED.exec(value.trim());
    return m ? { day: m[1], sep: m[2] ?? ' ', time: m[3] ?? '', rest: m[4] ?? '' } : undefined;
}

/** `value` on another day, keeping its time, fractions and zone as the database printed them */
export function withDay(value: string, day: string, timed: boolean) {
    if (!timed) return day;
    const p = dateParts(value);
    return p?.time ? `${day}${p.sep}${p.time}${p.rest}` : `${day} 00:00:00`;
}

/** `value` at another time (HH:MM:SS). The old fractions no longer apply; the zone still does */
export function withTime(value: string, time: string) {
    const p = dateParts(value);
    return p ? `${p.day}${p.sep}${time}${p.rest.replace(/^\.\d+/, '')}` : value;
}

const ZONED = /with time zone|timestamptz|datetimeoffset|timestamp_tz|timestamp_ltz/i;
/** Whether the column stores an instant, so a value can be entered in any zone */
export const isZoned = (typeName: string) => ZONED.test(typeName);

const OFFSET = /([+-])(\d{2}):?(\d{2})?$/;
/** Minutes `tz` is ahead of UTC at the instant `at` (ms) */
function zoneMinutes(tz: string, at: number) {
    const p = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
            .formatToParts(at)
            .map((x) => [x.type, +x.value]),
    );
    return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000) / 60000;
}

/** The column's own offset in minutes, as the database printed it on `value` (UTC when it has none) */
export function columnMinutes(value: string | null) {
    const m = OFFSET.exec(dateParts(value ?? '')?.rest ?? '');
    return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +(m[3] ?? 0)) : 0;
}

/** `draft`, read as a wall-clock time in `tz`, written at the column's offset (shortcut: fixed offset, no DST of its own; fractions dropped) */
export function toColumnZone(draft: string, tz: string, value: string | null) {
    const p = dateParts(draft);
    if (!p?.time) return draft;
    const [h, mi, s = 0] = p.time.split(':').map(Number);
    const [y, mo, d] = p.day.split('-').map(Number);
    const wall = Date.UTC(y, mo - 1, d, h, mi, s);
    // Twice, so a wall time near a DST change lands on the right side of it
    const instant = wall - zoneMinutes(tz, wall - zoneMinutes(tz, wall) * 60000) * 60000;
    const col = columnMinutes(value);
    const iso = new Date(instant + col * 60000).toISOString();
    const abs = Math.abs(col);
    const off = `${col < 0 ? '-' : '+'}${String(Math.trunc(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
    return `${iso.slice(0, 10)}${p.sep}${iso.slice(11, 19)}${off}`;
}
