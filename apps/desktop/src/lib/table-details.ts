import { useEffect, useState } from 'react';
import { commands, type DetailColumn, type IncomingRef, type TableDetails } from '@/bindings';
import type { Inspected } from '@/stores/ui';

// One fetch per table until refreshed, shared by the inspector and the grid: clicking back and forth doesn't refetch
const cache = new Map<string, Promise<TableDetails>>();

/** One table's identity: its details' cache key, and its table tab's id */
export const tableKey = (t: Inspected) => JSON.stringify([t.connectionId, t.database, t.schema, t.table]);

/** After a refresh (the schema may have changed) or a disconnect */
export function forgetDetails(connectionId: string) {
    for (const key of cache.keys()) if ((JSON.parse(key) as string[])[0] === connectionId) cache.delete(key);
}

export function detailsOf(t: Inspected, fresh = false) {
    const key = tableKey(t);
    if (fresh) cache.delete(key);
    let details = cache.get(key);
    if (!details) {
        details = commands.tableDetails(t.connectionId, t.database || null, t.schema, t.table).catch((error) => {
            cache.delete(key);
            throw error;
        });
        cache.set(key, details);
    }
    return details;
}

/** A table's details once loaded (undefined before, or when loading failed); never another table's */
export function useTableDetails(t: Inspected) {
    // Tagged with its table, so a new table never shows the old one's details
    const [loaded, setLoaded] = useState<{ for: string; details: TableDetails } | null>(null);
    const key = tableKey(t);
    useEffect(() => {
        detailsOf(t).then(
            (details) => setLoaded({ for: key, details }),
            () => {},
        );
    }, [key]);
    return loaded?.for === key ? loaded.details : undefined;
}

/** "public.users(id)": where a foreign key column points, or undefined for any other column */
export function referenceOf(c: DetailColumn) {
    if (!c.references) return undefined;
    return `${c.referencesSchema ? `${c.referencesSchema}.` : ''}${c.references}${c.referencesColumn ? `(${c.referencesColumn})` : ''}`;
}

/** A table and one of its columns, to open filtered on that column */
export type Related = Pick<IncomingRef, 'schema' | 'table' | 'column'>;
