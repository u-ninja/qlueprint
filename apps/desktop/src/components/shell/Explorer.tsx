import { createContext, useContext, useDeferredValue, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
    ChevronRight,
    Copy,
    Database,
    Eye,
    Folder,
    FolderInput,
    PanelRight,
    Pencil,
    Plug,
    RefreshCw,
    RotateCw,
    Rows3,
    ScrollText,
    Search,
    SquareFunction,
    SquarePen,
    Table2,
    TextCursorInput,
    Trash2,
    Unplug,
    X,
    type LucideIcon,
} from 'lucide-react';
import { commands, type Engine, type Routine, type SavedConfig, type SavedConnection, type Schema, type Table } from '@/bindings';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuDestructiveItem,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuShortcut,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { closedState, errorMessage, useConnections, type Closed, type Connection, type ConnectionState } from '@/stores/connections';
import { qualifiedName, selectSql, useQuery } from '@/stores/query';
import { useInWorkspace, useUi } from '@/stores/ui';
import { Input } from '@/components/ui/input';
import { Skeleton, Spinner } from '@/components/ui/loading';
import { cn, count, formatBytes } from '@/lib/utils';
import { useCopy } from '@/lib/use-copy';
import { serverName } from '@/lib/connection-string';
import { engineName, hasDatabases } from '@/lib/engines';
import { ConnectDialog } from './ConnectDialog';
import { EngineLogo } from './engine-logos';
import { StatusDot } from './StatusDot';

// How long a click waits to see if it's the start of a double-click (the usual system default is about this)
const DOUBLE_CLICK_MS = 250;

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

/** Opens a query tab on this connection (and database, when given) */
function newQueryOn(connectionId: string, database?: string) {
    const q = useQuery.getState();
    q.newQuery();
    q.setConnectionId(connectionId);
    if (database !== undefined) q.setDatabase(database);
}

/** Shift+F10 or the menu key opens the focused row’s menu under it (WebKit doesn’t do this itself) */
function menuKey(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
    e.preventDefault();
    const { left, bottom } = e.currentTarget.getBoundingClientRect();
    e.target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: left + 24, clientY: bottom }));
}

/** Right-click (or the keyboard, see menuKey) on `children` opens `menu`'s items */
function RowMenu({ menu, onCloseAutoFocus, children }: { menu: ReactNode; onCloseAutoFocus?: (e: Event) => void; children: ReactNode }) {
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild onKeyDown={menuKey}>
                {children}
            </ContextMenuTrigger>
            <ContextMenuContent onCloseAutoFocus={onCloseAutoFocus}>{menu}</ContextMenuContent>
        </ContextMenu>
    );
}

function Branch(props: {
    lead: ReactNode;
    label: string;
    defaultOpen: boolean;
    meta?: ReactNode;
    actions?: ReactNode;
    /** Context menu items for the row */
    menu?: ReactNode;
    onMenuCloseAutoFocus?: (e: Event) => void;
    /** Replaces the label (an inline rename input): an input can't sit inside the toggle button */
    rename?: ReactNode;
    /** Shown open whatever its own state, e.g. while the filter has a match inside */
    forceOpen?: boolean;
    children: ReactNode;
}) {
    const { lead, label, defaultOpen, meta, actions, menu, onMenuCloseAutoFocus, rename, forceOpen, children } = props;
    const [userOpen, setOpen] = useState(defaultOpen);
    const open = userOpen || !!forceOpen;
    const head = (
        <>
            <ChevronRight className={cn('size-3.5 flex-none text-fg3', open && 'rotate-90')} aria-hidden />
            <span className={glyph}>{lead}</span>
        </>
    );
    const line = (
        <div className={cn(row, 'data-[state=open]:bg-hover')}>
            {rename ? (
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    {head}
                    {rename}
                </span>
            ) : (
                <button aria-expanded={open} onClick={() => setOpen(!open)} disabled={forceOpen} className="flex min-w-0 flex-1 items-center gap-1.5">
                    {head}
                    <span className="truncate">{label}</span>
                </button>
            )}
            <RowEnd meta={meta} actions={actions} />
        </div>
    );
    return (
        <li>
            {menu ? (
                <RowMenu menu={menu} onCloseAutoFocus={onMenuCloseAutoFocus}>
                    {line}
                </RowMenu>
            ) : (
                line
            )}
            {/* Children mount only while open, so a closed schema with thousands of tables costs nothing */}
            {open && <ul className="pl-4">{children}</ul>}
        </li>
    );
}

/** The other workspaces, to move a connection to; nothing when there's only one */
function MoveToWorkspace({ savedId }: { savedId: string }) {
    const workspaces = useUi((s) => s.workspaces);
    const current = useUi((s) => s.workspace);
    const others = workspaces.filter((w) => w.id !== current);
    if (!others.length) return null;
    return (
        <ContextMenuSub>
            <ContextMenuSubTrigger>
                <FolderInput aria-hidden />
                Move to workspace
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
                {others.map((w) => (
                    <ContextMenuItem key={w.id} onSelect={() => useUi.getState().moveConnection(savedId, w.id)}>
                        {w.name}
                    </ContextMenuItem>
                ))}
            </ContextMenuSubContent>
        </ContextMenuSub>
    );
}

/** user@host:port/database (SQL Server: host\\instance), or a SQLite file’s path: never the password */
function connectionDetails(config: SavedConfig) {
    if (config.kind === 'sqlite') return config.path;
    const { user, host, port, database } = config;
    // The Azure CLI and managed identity sign in without a user name
    const server = serverName(host, config.kind === 'mssql' ? (config.instance ?? '') : '');
    return `${user ? `${user}@` : ''}${server}:${port}${database ? `/${database}` : ''}`;
}

/** The connection’s name as an input: Enter or leaving it saves, Escape cancels; blank keeps the old name */
function RenameInput({ saved, onDone }: { saved: SavedConnection; onDone: () => void }) {
    const rename = useConnections((s) => s.rename);
    const [error, setError] = useState('');
    const finished = useRef(false);

    async function save(value: string) {
        if (finished.current) return;
        finished.current = true;
        const label = value.trim();
        if (label && label !== saved.label) {
            try {
                await rename(saved.id, label);
            } catch (err) {
                finished.current = false;
                setError(errorMessage(err));
                return;
            }
        }
        onDone();
    }

    return (
        <>
            {/* The row has no room for the error: it's the tooltip, and read out here */}
            <span role="alert" className="sr-only">
                {error}
            </span>
            <input
                autoFocus
                autoComplete="off"
                defaultValue={saved.label}
                aria-label="Connection name"
                aria-invalid={!!error || undefined}
                title={error || undefined}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => void save(e.currentTarget.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') void save(e.currentTarget.value);
                    if (e.key === 'Escape') {
                        e.stopPropagation();
                        finished.current = true;
                        onDone();
                    }
                }}
                className="h-6 min-w-0 flex-1 rounded bg-background px-1 outline-none ring-1 ring-ring aria-invalid:ring-danger"
            />
        </>
    );
}

type Pending = 'rename' | 'edit' | 'remove';

/** A connection's engine logo with its state as a dot on the corner, ringed so it reads over the logo */
function ConnectionLogo({ kind, state }: { kind: Engine; state: ConnectionState }) {
    return (
        <span className="relative grid">
            <EngineLogo id={kind} className="size-3.5" />
            {/* Connecting shows a spinner beside the logo instead */}
            {state !== 'connecting' && (
                <span className="absolute -right-0.5 -bottom-0.5 flex rounded-full ring-2 ring-panel group-hover:ring-hover">
                    <StatusDot state={state} />
                </span>
            )}
        </span>
    );
}

/**
 * A saved connection, open (`c`) or not: its row, its right-click menu, and the edit and remove
 * dialogs that menu opens.
 */
function ConnectionNode({ saved, c, state }: { saved: SavedConnection; c: Connection | undefined; state: Closed | undefined }) {
    const { open, disconnect, refresh, forget } = useConnections.getState();
    const [, copy] = useCopy();
    const filter = useContext(FilterContext);
    const [renaming, setRenaming] = useState(false);
    const [dialog, setDialog] = useState<Exclude<Pending, 'rename'> | null>(null);
    // Chosen in the menu, started once it has closed: a rename keeps focus in its input
    // instead of the menu handing it back to the row, and a dialog returns focus to the row
    const pending = useRef<Pending | null>(null);
    const afterMenu = (e: Event) => {
        const next = pending.current;
        pending.current = null;
        if (next === 'rename') {
            e.preventDefault();
            setRenaming(true);
        } else if (next) setDialog(next);
    };
    const connecting = state === 'connecting';

    const menu = (
        <>
            {c ? (
                <>
                    <ContextMenuItem onSelect={() => newQueryOn(c.id)}>
                        <SquarePen aria-hidden />
                        New query
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void refresh(c.id).catch(() => {})}>
                        <RefreshCw aria-hidden />
                        Refresh
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => void disconnect(c.id).then(() => open(saved.id))}>
                        <RotateCw aria-hidden />
                        Reconnect
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void disconnect(c.id)}>
                        <Unplug aria-hidden />
                        Disconnect
                    </ContextMenuItem>
                </>
            ) : (
                <ContextMenuItem disabled={connecting} onSelect={() => void open(saved.id)}>
                    <Plug aria-hidden />
                    Connect
                </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem
                onSelect={() => {
                    pending.current = 'edit';
                }}
            >
                <Pencil aria-hidden />
                Edit connection…
            </ContextMenuItem>
            <ContextMenuItem
                onSelect={() => {
                    pending.current = 'rename';
                }}
            >
                <TextCursorInput aria-hidden />
                Rename
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => copy(connectionDetails(saved.config))}>
                <Copy aria-hidden />
                Copy connection details
            </ContextMenuItem>
            <MoveToWorkspace savedId={saved.id} />
            <ContextMenuSeparator />
            <ContextMenuDestructiveItem
                onSelect={() => {
                    pending.current = 'remove';
                }}
            >
                <Trash2 aria-hidden />
                Remove…
            </ContextMenuDestructiveItem>
        </>
    );
    const rename = renaming && <RenameInput saved={saved} onDone={() => setRenaming(false)} />;

    const dialogs = (
        <>
            <ConnectDialog edit={saved} open={dialog === 'edit'} onOpenChange={(o) => setDialog(o ? 'edit' : null)} />
            <AlertDialog open={dialog === 'remove'} onOpenChange={(o) => setDialog(o ? 'remove' : null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Remove {saved.label}?</AlertDialogTitle>
                        <AlertDialogDescription>
                            QluePrint forgets this connection and deletes its saved password. The database itself isn’t touched.
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
    );

    if (c)
        return (
            <>
                <Branch
                    lead={<ConnectionLogo kind={saved.config.kind} state="open" />}
                    label={c.label}
                    defaultOpen
                    forceOpen={!!filter}
                    menu={menu}
                    onMenuCloseAutoFocus={afterMenu}
                    rename={rename}
                    actions={
                        <button onClick={() => void disconnect(c.id)} aria-label={`Disconnect ${c.label}`} title="Disconnect" className={rowAction}>
                            <X className="size-3.5" aria-hidden />
                        </button>
                    }
                >
                    {/* Postgres and SQL Server have schemas inside each database; MySQL's databases are its schemas */}
                    {hasDatabases(c.kind) && c.switchable ? <Databases c={c} /> : <Schemas c={c} schemas={c.schemas} database={c.database} />}
                </Branch>
                {dialogs}
            </>
        );

    // Not open: connecting, failed, or disconnected by the user
    const error = typeof state === 'object' ? state.error : undefined;
    return (
        <li>
            <RowMenu menu={menu} onCloseAutoFocus={afterMenu}>
                {/* The keyboard reaches its menu through the row's buttons (menuKey) */}
                <div className={cn(row, 'data-[state=open]:bg-hover')}>
                    {rename || (
                        // Clicking a closed connection connects it; it then opens like any other branch
                        <button
                            onClick={() => !connecting && void open(saved.id)}
                            aria-label={connecting ? `Connecting to ${saved.label}` : `Connect to ${saved.label}`}
                            aria-busy={connecting || undefined}
                            title={error ? `${error} · click to try again` : connecting ? 'Connecting…' : 'Click to connect'}
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        >
                            <ChevronRight className="size-3.5 flex-none text-fg3" aria-hidden />
                            <span className={glyph}>
                                <ConnectionLogo kind={saved.config.kind} state={closedState(state)} />
                            </span>
                            {connecting && <Spinner className="size-3 text-fg3" />}
                            <span className="min-w-0 flex-1 truncate text-fg3">{saved.label}</span>
                        </button>
                    )}
                    <RowEnd
                        meta={
                            connecting && (
                                <span role="status" className="sr-only">
                                    Connecting…
                                </span>
                            )
                        }
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
                                    <button
                                        onClick={() => setDialog('remove')}
                                        aria-label={`Remove ${saved.label}`}
                                        title="Remove"
                                        className={rowAction}
                                    >
                                        <Trash2 className="size-3.5" aria-hidden />
                                    </button>
                                </>
                            )
                        }
                    />
                </div>
            </RowMenu>
            {error && (
                <p role="alert" className="truncate pr-1 pl-10 text-xs text-danger" title={error}>
                    {error}
                </p>
            )}
            {dialogs}
        </li>
    );
}

const note = 'h-7 truncate px-6 leading-7';

/** The explorer's filter, lowercased; '' shows everything */
const FilterContext = createContext('');

const matching = <T extends { name: string }>(items: T[], filter: string) =>
    filter ? items.filter((t) => t.name.toLowerCase().includes(filter)) : items;

/** The part of a name the filter matched, marked so the eye lands on why it's listed */
function Highlight({ text }: { text: string }) {
    const filter = useContext(FilterContext);
    const at = filter ? text.toLowerCase().indexOf(filter) : -1;
    if (at < 0) return text;
    return (
        <>
            {text.slice(0, at)}
            <mark className="rounded-sm bg-warning-soft text-foreground">{text.slice(at, at + filter.length)}</mark>
            {text.slice(at + filter.length)}
        </>
    );
}

/** A table or view. Double-click (or Enter) shows its rows; right-click for more */
function TableRow({ c, database, schema, table }: { c: Connection; database: string; schema: string; table: Table }) {
    const openTable = useQuery((s) => s.openTable);
    const [, copy] = useCopy();
    // MySQL's schemas are its databases, so the table's database is its schema there
    const db = c.kind === 'mysql' ? schema : database;
    const open = () => void openTable(c.id, db, schema, table.name);
    const inspect = useUi((s) => s.inspect);
    // A single click inspects only once it's clear no second click follows: the first click of a
    // double-click would otherwise open the inspector as well as the table
    const clickTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(clickTimer.current), []);
    const inspected = useUi((s) => {
        const t = s.inspected;
        return t?.connectionId === c.id && t.database === db && t.schema === schema && t.table === table.name;
    });
    const Icon = table.view ? Eye : Table2;
    const size = table.sizeBytes ?? null;
    const sizeText = size === null ? null : formatBytes(size);
    const title = `${table.name}${table.view ? ' (view)' : ''}${size === null ? '' : ` · ${sizeText} (${count(size, 'byte')})`}`;

    return (
        <li>
            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <button
                        // One click shows it in the inspector, two open its rows
                        onClick={(e) => {
                            clearTimeout(clickTimer.current);
                            if (e.detail > 1) return;
                            clickTimer.current = setTimeout(
                                () => inspect({ connectionId: c.id, database: db, schema, table: table.name }),
                                DOUBLE_CLICK_MS,
                            );
                        }}
                        onDoubleClick={() => {
                            clearTimeout(clickTimer.current);
                            open();
                        }}
                        onKeyDown={(e) => e.key === 'Enter' && open()}
                        aria-current={inspected || undefined}
                        className={cn(
                            row,
                            'w-full pl-6 text-left focus-visible:bg-hover data-[state=open]:bg-hover',
                            inspected && 'bg-primary-soft text-primary-text hover:bg-primary-soft',
                        )}
                        title={title}
                    >
                        <Icon className="size-3.5 flex-none text-fg3" aria-label={table.view ? 'View' : 'Table'} />
                        <span className="truncate">
                            <Highlight text={table.name} />
                        </span>
                        {sizeText && <span className="ml-auto flex-none pr-1 font-mono text-[11px] text-fg4">{sizeText}</span>}
                    </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                    <ContextMenuItem onSelect={open}>
                        <Rows3 aria-hidden />
                        Open data
                        <ContextMenuShortcut>Double-click</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => inspect({ connectionId: c.id, database: db, schema, table: table.name })}>
                        <PanelRight aria-hidden />
                        Show in inspector
                        <ContextMenuShortcut>Click</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => copy(table.name)}>
                        <Copy aria-hidden />
                        Copy name
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => copy(qualifiedName(c.kind, schema, table.name))}>
                        <Copy aria-hidden />
                        Copy qualified name
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => copy(selectSql(c.kind, schema, table.name))}>
                        <Copy aria-hidden />
                        Copy SELECT statement
                    </ContextMenuItem>
                </ContextMenuContent>
            </ContextMenu>
        </li>
    );
}

/** The menu of a database or schema row. `database` is where its queries run (MySQL: the schema itself) */
function ContainerMenu({ c, database, name }: { c: Connection; database: string; name: string }) {
    const refresh = useConnections((s) => s.refresh);
    const [, copy] = useCopy();
    return (
        <>
            <ContextMenuItem onSelect={() => newQueryOn(c.id, database)}>
                <SquarePen aria-hidden />
                New query here
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void refresh(c.id, database).catch(() => {})}>
                <RefreshCw aria-hidden />
                Refresh
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => copy(name)}>
                <Copy aria-hidden />
                Copy name
            </ContextMenuItem>
        </>
    );
}

/** Schema > table branches. The default schema starts open (MySQL: the saved database) */
function Schemas({ c, schemas, database }: { c: Connection; schemas: Schema[]; database: string }) {
    const filter = useContext(FilterContext);
    return schemas.map((s) => {
        const tables = matching(s.tables, filter);
        const routines = matching(s.routines, filter);
        // Filtering: schemas without a match drop out, the rest open to show theirs
        if (filter && !tables.length && !routines.length) return null;
        const [views, plain] = partition(tables, (t) => t.view);
        const [procedures, functions] = partition(routines, (r) => r.procedure);
        const tableRow = (t: Table) => <TableRow key={t.name} c={c} database={database} schema={s.name} table={t} />;
        const routineRow = (r: Routine, icon: LucideIcon) => (
            <RoutineRow key={`${r.name}(${r.args ?? ''})`} c={c} database={database} schema={s.name} routine={r} icon={icon} />
        );
        return (
            <Branch
                key={s.name}
                lead={<Folder className="size-3.5" aria-hidden />}
                label={s.name}
                meta={tables.length || undefined}
                defaultOpen={s.name === 'public' || s.name === database}
                forceOpen={!!filter}
                menu={<ContainerMenu c={c} database={c.kind === 'mysql' ? s.name : database} name={s.name} />}
            >
                {tables.length === 0 && routines.length === 0 && <li className={cn(note, 'text-fg3')}>No tables</li>}
                <Group label="Tables" icon={Table2} open count={plain.length}>
                    {plain.map(tableRow)}
                </Group>
                <Group label="Views" icon={Eye} open={!plain.length} count={views.length}>
                    {views.map(tableRow)}
                </Group>
                <Group label="Procedures" icon={ScrollText} count={procedures.length}>
                    {procedures.map((r) => routineRow(r, ScrollText))}
                </Group>
                <Group label="Functions" icon={SquareFunction} count={functions.length}>
                    {functions.map((r) => routineRow(r, SquareFunction))}
                </Group>
            </Branch>
        );
    });
}

/** One kind of a schema's objects (tables, views, procedures, functions) in its own branch; none, no branch */
function Group({
    label,
    icon: Icon,
    open = false,
    count: n,
    children,
}: {
    label: string;
    icon: LucideIcon;
    open?: boolean;
    count: number;
    children: ReactNode;
}) {
    const filter = useContext(FilterContext);
    if (!n) return null;
    return (
        <Branch lead={<Icon className="size-3.5" aria-hidden />} label={label} meta={n} defaultOpen={open} forceOpen={!!filter}>
            {/* shortcut: renders every row of an open branch, virtualize (TanStack Virtual) if 10k+ table schemas lag */}
            {children}
        </Branch>
    );
}

/** Splits a list in one pass: those `test` keeps, then the rest */
function partition<T>(items: T[], test: (item: T) => boolean): [T[], T[]] {
    const yes: T[] = [];
    const no: T[] = [];
    for (const item of items) (test(item) ? yes : no).push(item);
    return [yes, no];
}

/** Opens a query tab on its definition: double-click, Enter or its menu */
function RoutineRow(props: { c: Connection; database: string; schema: string; routine: Routine; icon: LucideIcon }) {
    const { c, database, schema, routine, icon: Icon } = props;
    const [, copy] = useCopy();
    // MySQL's schemas are its databases
    const db = c.kind === 'mysql' ? schema : database;
    const open = async () => {
        let sql: string;
        try {
            sql = await commands.routineDefinition(c.id, db || null, schema, routine.name, routine.procedure, routine.args ?? null);
        } catch (err) {
            sql = `-- Couldn’t load ${schema}.${routine.name}: ${errorMessage(err)}`;
        }
        newQueryOn(c.id, db);
        useQuery.getState().setSql(sql);
    };
    const label = routine.args == null ? routine.name : `${routine.name}(${routine.args})`;
    return (
        <li>
            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <button
                        onDoubleClick={() => void open()}
                        onKeyDown={(e) => e.key === 'Enter' && void open()}
                        className={cn(row, 'w-full pl-6 text-left focus-visible:bg-hover data-[state=open]:bg-hover')}
                        title={`${label} · double-click to open its definition`}
                    >
                        <Icon className="size-3.5 flex-none text-fg3" aria-label={routine.procedure ? 'Procedure' : 'Function'} />
                        <span className="truncate">
                            <Highlight text={routine.name} />
                            {routine.args != null && <span className="text-fg4">({routine.args})</span>}
                        </span>
                    </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                    <ContextMenuItem onSelect={() => void open()}>
                        <SquarePen aria-hidden />
                        Open definition
                        <ContextMenuShortcut>Double-click</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => copy(routine.name)}>
                        <Copy aria-hidden />
                        Copy name
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => copy(qualifiedName(c.kind, schema, routine.name))}>
                        <Copy aria-hidden />
                        Copy qualified name
                    </ContextMenuItem>
                </ContextMenuContent>
            </ContextMenu>
        </li>
    );
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
            <li role="status" aria-label="Loading schemas" className="flex flex-col gap-3 py-2 pl-6">
                {['w-24', 'w-32', 'w-20'].map((w) => (
                    <Skeleton key={w} className={w} />
                ))}
            </li>
        );
    return <Schemas c={c} schemas={schemas} database={database} />;
}

/** Postgres with "Show all databases": a database level above the schemas; its own database starts open */
function Databases({ c }: { c: Connection }) {
    const filter = useContext(FilterContext);
    // Filtering searches only databases already loaded: opening every one to search it would open a pool per database
    const shown = filter ? c.databases.filter((name) => countMatches(schemasOf(c, name), filter) > 0) : c.databases;
    return shown.map((name) => (
        <Branch
            key={name}
            lead={<Database className="size-3.5" aria-hidden />}
            label={name}
            defaultOpen={name === c.database}
            forceOpen={!!filter}
            menu={<ContainerMenu c={c} database={name} name={name} />}
        >
            {name === c.database ? <Schemas c={c} schemas={c.schemas} database={name} /> : <OtherDatabaseSchemas c={c} database={name} />}
        </Branch>
    ));
}

/** A database's loaded schemas: its own, or another one opened under "Show all databases" */
export function schemasOf(c: Connection, database: string) {
    return database === c.database ? c.schemas : (c.others[database] ?? []);
}

function countMatches(schemas: Schema[], filter: string) {
    return schemas.reduce((n, s) => n + matching(s.tables, filter).length, 0);
}

/** Saved connections; the open ones expand into their schema > table tree. The box on top narrows it to matching tables */
export function Explorer() {
    const {
        saved: everySaved,
        connections,
        closed,
    } = useConnections(useShallow((s) => ({ saved: s.saved, connections: s.connections, closed: s.closed })));
    // The shown workspace's connections only
    const inWorkspace = useInWorkspace();
    const saved = everySaved.filter((s) => inWorkspace(s.id));
    const [query, setQuery] = useState('');
    // The box keeps up with typing; the tree filters behind it
    const filter = useDeferredValue(query.trim().toLowerCase());
    // Every loaded database of every open connection, so the count matches what the tree can show
    const found = filter ? connections.reduce((n, c) => n + countMatches([c.schemas, ...Object.values(c.others)].flat(), filter), 0) : 0;
    // One group per engine in use, by name; each keeps its connections in saved order. Filtering:
    // closed connections have nothing to match. One pass, then a lookup per row
    const openBySaved = new Map(connections.map((c) => [c.savedId, c]));
    const groups = new Map<Engine, SavedConnection[]>();
    for (const entry of saved) {
        if (filter && !openBySaved.has(entry.id)) continue;
        const group = groups.get(entry.config.kind);
        if (group) group.push(entry);
        else groups.set(entry.config.kind, [entry]);
    }
    const kinds = [...groups.keys()].sort((a, b) => engineName[a].localeCompare(engineName[b]));

    return (
        <FilterContext value={filter}>
            {connections.length > 0 && (
                <div role="search" className="sticky top-0 z-10 bg-panel px-1.5 pb-1.5">
                    <div className="relative">
                        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg4" aria-hidden />
                        <Input
                            type="search"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
                            placeholder="Filter tables…"
                            autoComplete="off"
                            aria-label="Filter tables and views by name"
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                            className="h-7 pl-7 text-[13px]"
                        />
                    </div>
                    {filter && (
                        <p role="status" className="px-1 pt-1 text-[11px] text-fg4">
                            {found ? count(found, 'match', 'matches') : 'No tables match'}
                        </p>
                    )}
                </div>
            )}
            <ul aria-label="Database explorer" className="px-1.5">
                {kinds.map((kind) => {
                    const entries = groups.get(kind)!;
                    return (
                        <Branch
                            key={kind}
                            lead={<EngineLogo id={kind} className="size-3.5" />}
                            label={engineName[kind]}
                            meta={entries.length}
                            defaultOpen
                            forceOpen={!!filter}
                        >
                            {entries.map((entry) => (
                                <ConnectionNode key={entry.id} saved={entry} c={openBySaved.get(entry.id)} state={closed[entry.id]} />
                            ))}
                        </Branch>
                    );
                })}
            </ul>
        </FilterContext>
    );
}
