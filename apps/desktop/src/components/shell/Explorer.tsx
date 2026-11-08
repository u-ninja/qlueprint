import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Database, Eye, Folder, Plug, Table2, Trash2, X } from 'lucide-react';
import type { SavedConnection, Schema } from '@/bindings';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { closedState, errorMessage, useConnections, type Closed, type Connection } from '@/stores/connections';
import { cn } from '@/lib/utils';
import { StatusDot } from './StatusDot';

const row = 'group flex h-7 items-center gap-1.5 rounded-md px-1 hover:bg-hover';
// Every row's leading glyph sits in the same 14px box, so labels line up whatever the glyph
const glyph = 'grid size-3.5 flex-none place-items-center text-fg3';

const rowAction =
    'grid size-5 place-items-center rounded text-fg3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-foreground';

/**
 * The right edge of a row: quiet mono meta (the engine id, a count; lowercase on purpose, like a
 * terminal) that gives way to the row's actions on hover or
 * keyboard focus. Both share one grid cell, and the actions only fade, so they stay in the tab order.
 */
function RowEnd({ meta, actions }: { meta?: ReactNode; actions?: ReactNode }) {
    return (
        <span className="grid flex-none *:col-start-1 *:row-start-1">
            {meta && (
                <span className="justify-self-end pr-1 font-mono text-[11px] text-fg4 group-focus-within:invisible group-hover:invisible">
                    {meta}
                </span>
            )}
            {actions && <span className="flex justify-self-end">{actions}</span>}
        </span>
    );
}

function Branch(props: { lead: ReactNode; label: string; defaultOpen: boolean; meta?: ReactNode; actions?: ReactNode; children: ReactNode }) {
    const { lead, label, defaultOpen, meta, actions, children } = props;
    const [open, setOpen] = useState(defaultOpen);
    return (
        <li>
            <div className={row}>
                <button aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-1.5">
                    <ChevronRight className={cn('size-3.5 flex-none text-fg3', open && 'rotate-90')} aria-hidden />
                    <span className={glyph}>{lead}</span>
                    <span className="truncate">{label}</span>
                </button>
                <RowEnd meta={meta} actions={actions} />
            </div>
            {/* Children mount only while open, so a closed schema with thousands of tables costs nothing */}
            {open && <ul className="pl-4">{children}</ul>}
        </li>
    );
}

/** A saved connection that isn't open: connecting, failed, or disconnected by the user */
function ClosedConnection({ saved, state }: { saved: SavedConnection; state: Closed | undefined }) {
    const open = useConnections((s) => s.open);
    const forget = useConnections((s) => s.forget);
    const connecting = state === 'connecting';
    const error = typeof state === 'object' ? state.error : undefined;

    return (
        <li>
            <div className={row}>
                <span className="size-3.5 flex-none" aria-hidden />
                <span className={glyph}>
                    <StatusDot state={closedState(state)} />
                </span>
                <span className="min-w-0 flex-1 truncate text-fg3">{saved.label}</span>
                <RowEnd
                    meta={connecting ? <span role="status">connecting…</span> : saved.config.kind}
                    actions={
                        !connecting && (
                            <>
                                <button
                                    onClick={() => void open(saved.id)}
                                    aria-label={`Connect ${saved.label}`}
                                    title="Connect"
                                    className={rowAction}
                                >
                                    <Plug className="size-3.5" aria-hidden />
                                </button>
                                <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                        <button aria-label={`Remove ${saved.label}`} title="Remove" className={rowAction}>
                                            <Trash2 className="size-3.5" aria-hidden />
                                        </button>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                        <AlertDialogHeader>
                                            <AlertDialogTitle>Remove {saved.label}?</AlertDialogTitle>
                                            <AlertDialogDescription>
                                                QueryCraft forgets this connection and deletes its saved password. The database itself isn’t touched.
                                            </AlertDialogDescription>
                                        </AlertDialogHeader>
                                        <AlertDialogFooter>
                                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                                            <AlertDialogAction variant="destructive" onClick={() => void forget(saved.id)}>
                                                Remove connection
                                            </AlertDialogAction>
                                        </AlertDialogFooter>
                                    </AlertDialogContent>
                                </AlertDialog>
                            </>
                        )
                    }
                />
            </div>
            {error && (
                <p className="truncate pr-1 pl-10 text-xs text-danger" title={error}>
                    {error}
                </p>
            )}
        </li>
    );
}

const note = 'h-7 truncate px-6 leading-7';

/** Schema > table branches. The default schema starts open (MySQL: the saved database) */
function Schemas({ schemas, database }: { schemas: Schema[]; database: string }) {
    return schemas.map((s) => (
        <Branch
            key={s.name}
            lead={<Folder className="size-3.5" aria-hidden />}
            label={s.name}
            meta={s.tables.length || undefined}
            defaultOpen={s.name === 'public' || s.name === database}
        >
            {s.tables.length === 0 && <li className={cn(note, 'text-fg3')}>No tables</li>}
            {/* shortcut: renders every table of an open schema, virtualize (TanStack Virtual) if 10k+ table schemas lag */}
            {s.tables.map((t) => {
                const Icon = t.view ? Eye : Table2;
                return (
                    <li key={t.name} className={cn(row, 'pl-6')} title={t.view ? `${t.name} (view)` : t.name}>
                        <Icon className="size-3.5 flex-none text-fg3" aria-label={t.view ? 'View' : 'Table'} />
                        <span className="truncate">{t.name}</span>
                    </li>
                );
            })}
        </Branch>
    ));
}

/**
 * Another Postgres database on the same server. It mounts only when its branch opens, so its pool
 * (opened by Rust on first use) and schemas load on demand, once: the store keeps them.
 */
function OtherDatabaseSchemas({ c, database }: { c: Connection; database: string }) {
    const loadOtherDatabase = useConnections((s) => s.loadOtherDatabase);
    const schemas = c.others[database];
    const [error, setError] = useState('');
    useEffect(() => {
        if (!schemas) loadOtherDatabase(c.id, database).catch((err) => setError(errorMessage(err)));
    }, [schemas, loadOtherDatabase, c.id, database]);

    if (error)
        return (
            <li className={cn(note, 'text-xs text-danger')} title={error}>
                {error}
            </li>
        );
    if (!schemas)
        return (
            <li role="status" className={cn(note, 'font-mono text-[11px] text-fg4')}>
                loading…
            </li>
        );
    return <Schemas schemas={schemas} database={database} />;
}

/** Postgres with "Show all databases": a database level above the schemas; its own database starts open */
function Databases({ c }: { c: Connection }) {
    return c.databases.map((name) => (
        <Branch key={name} lead={<Database className="size-3.5" aria-hidden />} label={name} defaultOpen={name === c.database}>
            {name === c.database ? <Schemas schemas={c.schemas} database={name} /> : <OtherDatabaseSchemas c={c} database={name} />}
        </Branch>
    ));
}

/** Saved connections; the open ones expand into their schema > table tree. */
export function Explorer() {
    const { saved, connections, closed, disconnect } = useConnections();

    return (
        <ul aria-label="Database explorer" className="px-1.5">
            {saved.map((entry) => {
                const c = connections.find((open) => open.savedId === entry.id);
                if (!c) return <ClosedConnection key={entry.id} saved={entry} state={closed[entry.id]} />;
                return (
                    <Branch
                        key={c.id}
                        lead={<StatusDot state="open" />}
                        label={c.label}
                        meta={c.kind}
                        defaultOpen
                        actions={
                            <button
                                onClick={() => void disconnect(c.id)}
                                aria-label={`Disconnect ${c.label}`}
                                title="Disconnect"
                                className={rowAction}
                            >
                                <X className="size-3.5" aria-hidden />
                            </button>
                        }
                    >
                        {/* Postgres has schemas inside each database; MySQL's databases are its schemas */}
                        {c.kind === 'postgres' && c.switchable ? <Databases c={c} /> : <Schemas schemas={c.schemas} database={c.database} />}
                    </Branch>
                );
            })}
        </ul>
    );
}
