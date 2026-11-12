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
