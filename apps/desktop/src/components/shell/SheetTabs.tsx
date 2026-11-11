import { useState, type ReactNode } from 'react';
import { Copy, FileCode2, Pencil, Plus, RotateCw, Save, Table2, X } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuShortcut,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useConnections } from '@/stores/connections';
import { isDirty, useQuery } from '@/stores/query';
import { cn, newQueryShortcut, saveShortcut } from '@/lib/utils';

const sheetTab = 'h-full flex-none gap-1.5 px-1 text-[13px] font-normal';

/** Renames a query tab in place: Enter or leaving saves, Escape cancels, blank keeps the old name */
function RenameInput({ id, title, onDone }: { id: string; title: string; onDone: () => void }) {
    const renameQuery = useQuery((s) => s.renameQuery);
    const [value, setValue] = useState(title);
    const commit = () => {
        renameQuery(id, value);
        onDone();
    };
    return (
        <input
            autoFocus
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                else if (e.key === 'Escape') onDone();
            }}
            aria-label="Query tab name"
            spellCheck={false}
            className="h-6 w-36 rounded border border-ring bg-transparent px-1.5 text-[13px] outline-none"
        />
    );
}

type TabProps = {
    id: string;
    label: string;
    /** The tooltip; the label by default */
    title?: string;
    icon: typeof FileCode2;
    active: boolean;
    running: boolean;
    dirty: boolean;
    /** The tab's own menu items (Save, Rename… or Reload); the close items are shared */
    menu: ReactNode;
    /** Only a tab that can be renamed (has `onRename`) takes these */
    renaming?: boolean;
    onRename?: () => void;
    onRenamed?: () => void;
    onClose: (ids: string[]) => void;
    /** Every tab id in strip order, for Close others / to the right */
    order: string[];
};

function SheetTab({ id, label, title = label, icon: Icon, active, running, dirty, menu, renaming, onRename, onRenamed, onClose, order }: TabProps) {
    const index = order.indexOf(id);
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <div className="group flex h-full flex-none items-center gap-0.5">
                    {renaming && onRenamed ? (
                        <span className="flex items-center gap-1.5 px-1">
                            <Icon className="size-3.5 text-fg3" aria-hidden />
                            <RenameInput id={id} title={label} onDone={onRenamed} />
                        </span>
                    ) : (
                        <TabsTrigger
                            value={id}
                            className={sheetTab}
                            title={dirty ? `${title} · unsaved changes` : title}
                            // Middle-click closes, as in a browser
                            onAuxClick={(e) => e.button === 1 && onClose([id])}
                            onDoubleClick={onRename}
                        >
                            <Icon className={cn('size-3.5', running && 'animate-pulse text-primary-text')} aria-hidden />
                            <span className="max-w-48 truncate">{label}</span>
                        </TabsTrigger>
                    )}
                    {/* One slot: the unsaved dot, which gives way to × on hover, like an editor's tabs */}
                    <button
                        onClick={() => onClose([id])}
                        aria-label={dirty ? `Close ${label} (unsaved changes)` : `Close ${label}`}
                        title="Close"
                        className={cn(
                            'grid size-5 place-items-center rounded text-fg3 hover:bg-hover hover:text-foreground focus-visible:opacity-100',
                            !active && !dirty && 'opacity-0 group-hover:opacity-100',
                        )}
                    >
                        {dirty && <span className="size-2 rounded-full bg-fg2 group-hover:hidden" aria-hidden />}
                        <X className={cn('size-3.5', dirty && 'hidden group-hover:block')} aria-hidden />
                    </button>
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
                {menu}
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onClose([id])}>
                    <X aria-hidden />
                    Close
                </ContextMenuItem>
                <ContextMenuItem disabled={order.length < 2} onSelect={() => onClose(order.filter((t) => t !== id))}>
                    Close others
                </ContextMenuItem>
                <ContextMenuItem disabled={index === order.length - 1} onSelect={() => onClose(order.slice(index + 1))}>
                    Close to the right
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => onClose(order)}>Close all</ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}

/** Query tabs, then the tables opened from the explorer, then + for a new query */
export function SheetTabs() {
    const queries = useQuery((s) => s.queries);
    const tables = useQuery((s) => s.tables);
    const activeTab = useQuery((s) => s.activeTab);
    const { setActiveTab, newQuery, save, duplicateQuery, queryTable, requestClose, finishClose } = useQuery.getState();
    const closing = useQuery((s) => s.closing);
    const connections = useConnections((s) => s.connections);
    const [renaming, setRenaming] = useState<string | null>(null);

    const order = [...queries, ...tables].map((t) => t.id);
    // Query tabs with unsaved SQL and table tabs with unsaved edits, by name
    const dirtyClosing = [...queries, ...tables].filter((t) => closing.includes(t.id) && isDirty(t)).map((t) => ('title' in t ? t.title : t.table));

    return (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-none">
            <div className="flex h-9 items-center border-b border-border-soft pr-1.5">
                <TabsList variant="line" className="h-full min-w-0 justify-start gap-4 overflow-x-auto overflow-y-hidden scrollbar-none px-3 py-0">
                    {queries.map((q) => (
                        <SheetTab
                            key={q.id}
                            id={q.id}
                            label={q.title}
                            icon={FileCode2}
                            active={q.id === activeTab}
                            running={q.runningSince !== null}
                            dirty={isDirty(q)}
                            renaming={renaming === q.id}
                            onRename={() => setRenaming(q.id)}
                            onRenamed={() => setRenaming(null)}
                            onClose={requestClose}
                            order={order}
                            menu={
                                <>
                                    <ContextMenuItem disabled={!isDirty(q)} onSelect={() => save(q.id)}>
                                        <Save aria-hidden />
                                        Save
                                        <ContextMenuShortcut>{saveShortcut}</ContextMenuShortcut>
                                    </ContextMenuItem>
                                    {/* After the menu closes, so it doesn't take focus back from the input */}
                                    <ContextMenuItem onSelect={() => setTimeout(() => setRenaming(q.id))}>
                                        <Pencil aria-hidden />
                                        Rename
                                    </ContextMenuItem>
                                    <ContextMenuItem onSelect={() => duplicateQuery(q.id)}>
                                        <Copy aria-hidden />
                                        Duplicate
                                    </ContextMenuItem>
                                </>
                            }
                        />
                    ))}
                    {tables.map((t) => (
                        <SheetTab
                            key={t.id}
                            id={t.id}
                            label={t.table}
                            title={`${t.database}.${t.schema}.${t.table} on ${connections.find((c) => c.id === t.connectionId)?.label ?? 'a closed connection'}`}
                            icon={Table2}
                            active={t.id === activeTab}
                            running={t.runningSince !== null}
                            dirty={isDirty(t)}
                            onClose={requestClose}
                            order={order}
                            menu={
                                <ContextMenuItem disabled={t.runningSince !== null} onSelect={() => void queryTable(t.id, {})}>
                                    <RotateCw aria-hidden />
                                    Reload
                                </ContextMenuItem>
                            }
                        />
                    ))}
                </TabsList>
                {/* Right after the last tab, where the next one will appear */}
                <button
                    onClick={newQuery}
                    aria-label="New query"
                    title={`New query (${newQueryShortcut})`}
                    className="ml-1 grid size-6 flex-none place-items-center rounded text-fg3 hover:bg-hover hover:text-foreground"
                >
                    <Plus className="size-4" aria-hidden />
                </button>
            </div>

            <AlertDialog open={dirtyClosing.length > 0} onOpenChange={(open) => !open && finishClose(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {dirtyClosing.length === 1 ? `Save changes to ${dirtyClosing[0]}?` : `Save changes to ${dirtyClosing.length} tabs?`}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {dirtyClosing.length === 1
                                ? 'Its unsaved changes are lost if you close it without saving.'
                                : `${dirtyClosing.join(', ')} have unsaved changes, lost if you close them without saving.`}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <Button variant="outline" onClick={() => finishClose(false)}>
                            Don’t save
                        </Button>
                        <AlertDialogAction onClick={() => finishClose(true)}>Save</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Tabs>
    );
}
