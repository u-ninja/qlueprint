import { useEffect, useState } from 'react';
import { Check, Copy, RotateCw, X } from 'lucide-react';
import { useCopy } from '@/lib/use-copy';
import type { TableDetails } from '@/bindings';
import { Button } from '@/components/ui/button';
import { detailsOf, referenceOf, tableKey as keyOf } from '@/lib/table-details';
import { cn, count, formatBytes } from '@/lib/utils';
import { errorMessage, useConnections } from '@/stores/connections';
import { qualifiedName, useQuery } from '@/stores/query';
import { useUi, type Inspected } from '@/stores/ui';

type Loaded = { for: Inspected; details: TableDetails } | { for: Inspected; error: string };

const keyStyle: Record<string, string> = {
    PK: 'bg-warning-soft text-warning',
    FK: 'bg-info-soft text-info',
    UQ: 'bg-muted text-fg2',
};

/** "btree (user_id)" from Postgres' CREATE INDEX text; other engines already give the columns */
function indexColumns(columns: string) {
    const m = /USING (\w+) \((.*)\)/.exec(columns);
    return m ? `${m[1]} (${m[2]})` : columns;
}

/** The right-hand panel: the table picked in the explorer, its columns, keys and indexes, as the database reports them */
export function TableInspector() {
    const target = useUi((s) => s.inspected);
    const toggleInspector = useUi((s) => s.toggleInspector);
    const connection = useConnections((s) => s.connections.find((c) => c.id === target?.connectionId));
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [copied, copy] = useCopy();
    const [copiedName, copyName] = useCopy();
    // Tagged with its table, so picking another one never shows the old one's details
    const current = loaded && target && keyOf(loaded.for) === keyOf(target) ? loaded : null;

    const load = (t: Inspected, fresh = false) =>
        detailsOf(t, fresh).then(
            (details) => setLoaded({ for: t, details }),
            (error) => setLoaded({ for: t, error: errorMessage(error) }),
        );
    useEffect(() => {
        if (target) void load(target);
    }, [target]);

    const details = current && 'details' in current ? current.details : null;
    const copyDdl = () => copy(details?.ddl);
    const icon = 'grid size-6.5 place-items-center rounded-md text-fg3 hover:bg-hover hover:text-foreground';

    const stats = details && [
        details.view ? 'View' : null,
        details.estimatedRows != null ? `~${count(details.estimatedRows, 'row')}` : null,
        details.sizeBytes != null ? formatBytes(details.sizeBytes) : null,
        count(details.columns.length, 'column'),
    ];

    return (
        <aside aria-label="Inspector" className="flex h-full flex-col bg-panel">
            <header className="flex h-10 flex-none items-center gap-1 border-b border-border-soft pr-2 pl-3.5">
                <h2 className="mr-auto font-semibold">Inspector</h2>
                {target && (
                    <button onClick={() => void load(target, true)} aria-label="Refresh" title="Refresh" className={icon}>
                        <RotateCw className="size-3.5" aria-hidden />
                    </button>
                )}
                <button onClick={toggleInspector} aria-label="Close inspector" title="Close" className={icon}>
                    <X className="size-3.5" aria-hidden />
                </button>
            </header>

            {!target ? (
                <p className="grid flex-1 place-items-center px-6 text-center text-fg3">
                    Select a table in the explorer to see its columns, indexes and size.
                </p>
            ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-4.5 overflow-auto px-3.5 pt-3.5 pb-5">
                    <div className="flex flex-col gap-1">
                        <span className="font-mono text-sm font-medium break-all">{target.table}</span>
                        <span className="text-xs text-fg3">
                            {target.schema}
                            {connection && <> · {connection.label}</>}
                        </span>
                        {/* Only what the database reports: an estimate is marked as one, nothing is made up */}
                        {stats && (
                            <span
                                className="text-xs text-fg2"
                                title={details?.estimatedRows != null ? 'Row count estimated by the database' : undefined}
                            >
                                {stats.filter(Boolean).join(' · ')}
                            </span>
                        )}
                    </div>

                    <div className="flex gap-1.5">
                        <Button
                            size="sm"
                            className="flex-1"
                            onClick={() => void useQuery.getState().openTable(target.connectionId, target.database, target.schema, target.table)}
                        >
                            Open data
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            className="flex-1"
                            disabled={!details?.ddl}
                            title={details && !details.ddl ? 'The database gives no CREATE text for this table' : undefined}
                            onClick={copyDdl}
                        >
                            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                            {copied ? 'Copied' : 'Copy DDL'}
                        </Button>
                    </div>
                    {connection && (
                        <button
                            onClick={() => copyName(qualifiedName(connection.kind, target.schema, target.table))}
                            aria-live="polite"
                            className="-mt-2.5 self-start text-[11px] text-fg3 hover:text-foreground"
                        >
                            {copiedName ? 'Copied' : 'Copy qualified name'}
                        </button>
                    )}

                    {current && 'error' in current && (
                        <p role="alert" className="text-xs text-danger">
                            {current.error}
                        </p>
                    )}
                    {!current && (
                        <p role="status" className="font-mono text-[11px] text-fg4">
                            loading…
                        </p>
                    )}

                    {details && (
                        <>
                            <section aria-label="Columns" className="flex flex-col">
                                <h3 className="pb-1.5 text-[11px] font-medium text-fg3">Columns</h3>
                                {details.columns.map((c) => (
                                    <div
                                        key={c.name}
                                        className="flex h-7 items-center gap-2 border-b border-border-soft text-xs"
                                        title={[
                                            c.nullable ? 'Nullable' : 'Not null',
                                            c.default !== null && `default ${c.default}`,
                                            c.references && `references ${referenceOf(c)}`,
                                        ]
                                            .filter(Boolean)
                                            .join(' · ')}
                                    >
                                        <span className="min-w-0 flex-1 truncate font-mono">{c.name}</span>
                                        {c.key && (
                                            <span className={cn('rounded-sm px-1 py-px text-[9.5px] font-semibold', keyStyle[c.key])}>{c.key}</span>
                                        )}
                                        <span className="max-w-32 flex-none truncate font-mono text-[11px] text-fg3">{c.typeName}</span>
                                    </div>
                                ))}
                            </section>

                            {details.indexes.length > 0 && (
                                <section aria-label="Indexes" className="flex flex-col">
                                    <h3 className="pb-1.5 text-[11px] font-medium text-fg3">Indexes</h3>
                                    {details.indexes.map((x) => (
                                        <div key={x.name} className="flex flex-col gap-px border-b border-border-soft py-1.5">
                                            <span className="truncate font-mono text-[11.5px]" title={x.name}>
                                                {x.name}
                                            </span>
                                            <span className="truncate text-[11px] text-fg3" title={x.columns}>
                                                {[x.primary ? 'primary' : x.unique ? 'unique' : null, indexColumns(x.columns)]
                                                    .filter(Boolean)
                                                    .join(' · ')}
                                            </span>
                                        </div>
                                    ))}
                                </section>
                            )}
                        </>
                    )}
                </div>
            )}
        </aside>
    );
}
