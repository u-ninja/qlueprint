import { useRef, useState, type FormEvent } from 'react';
import { Check, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useConnections } from '@/stores/connections';
import { useQuery } from '@/stores/query';
import { LOCAL_WORKSPACE, useUi, workspaceOf, type WorkspaceInfo } from '@/stores/ui';
import { cn, count } from '@/lib/utils';

const item = 'group flex h-8 items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover';
const action =
    'grid size-6 place-items-center rounded text-fg3 outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50';

/** A workspace's name field: new or renamed, Enter keeps it, Escape leaves it */
function NameField({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
    const [name, setName] = useState(initial);
    // Enter, Escape and the blur that follows them all end it: only the first counts
    const ended = useRef(false);
    const end = (value: string | null) => {
        if (ended.current) return;
        ended.current = true;
        onDone(value);
    };
    const submit = (e: FormEvent) => {
        e.preventDefault();
        end(name.trim() || null);
    };
    return (
        <form onSubmit={submit} className="px-1 py-0.5">
            <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), end(null))}
                onBlur={() => end(name.trim() || null)}
                placeholder="Client name…"
                autoComplete="off"
                aria-label="Workspace name"
                className="h-7 text-[13px]"
            />
        </form>
    );
}

/**
 * The top bar's workspace switcher: one local workspace per client, each with its own saved
 * connections and query tabs. Local holds everything saved before workspaces existed
 */
export function WorkspaceSwitcher() {
    const workspaces = useUi((s) => s.workspaces);
    const current = useUi((s) => s.workspace);
    const placement = useUi((s) => s.placement);
    const saved = useConnections((s) => s.saved);
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState<string | 'new' | null>(null);
    const [removing, setRemoving] = useState<WorkspaceInfo | null>(null);
    const name = workspaces.find((w) => w.id === current)?.name ?? 'Local';
    // Connections per workspace, counted once
    const counts = new Map<string, number>();
    for (const c of saved) {
        const w = workspaceOf(placement, c.id);
        counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    const connectionsIn = (id: string) => counts.get(id) ?? 0;

    const show = (id: string) => {
        useQuery.getState().switchWorkspace(id);
        setOpen(false);
    };
    const created = (title: string | null) => {
        setEditing(null);
        if (title) show(useUi.getState().createWorkspace(title));
    };
    const renamed = (id: string, title: string | null) => {
        setEditing(null);
        if (title) useUi.getState().renameWorkspace(id, title);
    };
    const remove = (w: WorkspaceInfo) => {
        if (current === w.id) useQuery.getState().switchWorkspace(LOCAL_WORKSPACE);
        useQuery.getState().dropWorkspace(w.id);
        useUi.getState().removeWorkspace(w.id);
        setRemoving(null);
    };

    return (
        <>
            <Popover open={open} onOpenChange={(o) => (setOpen(o), setEditing(null))}>
                <PopoverAnchor asChild>
                    <button
                        type="button"
                        onClick={() => setOpen(!open)}
                        aria-haspopup="dialog"
                        aria-expanded={open}
                        title="Switch workspace"
                        className="flex h-7 max-w-48 flex-none items-center gap-1 rounded-md px-2 text-fg2 transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                        <span className="truncate">{name}</span>
                        <ChevronDown className="size-3.5 flex-none text-fg4" aria-hidden />
                    </button>
                </PopoverAnchor>
                <PopoverContent className="w-64 p-1" aria-label="Workspaces">
                    <p className="flex justify-between px-2 pt-1.5 pb-1 text-xs text-fg3">
                        Workspaces
                        <span className="pr-1.5 text-fg4">Connections</span>
                    </p>
                    <ul>
                        {workspaces.map((w) => (
                            <li key={w.id}>
                                {editing === w.id ? (
                                    <NameField initial={w.name} onDone={(title) => renamed(w.id, title)} />
                                ) : (
                                    <div className={cn(item, 'pr-1')}>
                                        <button
                                            type="button"
                                            onClick={() => show(w.id)}
                                            aria-current={w.id === current || undefined}
                                            className="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                                        >
                                            <Check className={cn('size-3.5 flex-none text-primary', w.id !== current && 'invisible')} aria-hidden />
                                            <span className={cn('truncate', w.id === current && 'font-medium')}>{w.name}</span>
                                        </button>
                                        {/* One slot for every row, so counts line up: the count, or on hover and focus the row's actions */}
                                        <span className="grid w-13 flex-none justify-items-end">
                                            <span
                                                className="col-start-1 row-start-1 self-center pr-1.5 text-xs text-fg4 tabular-nums group-focus-within:invisible group-hover:invisible"
                                                title={count(connectionsIn(w.id), 'connection')}
                                            >
                                                {connectionsIn(w.id)}
                                            </span>
                                            <span className="invisible col-start-1 row-start-1 flex gap-0.5 group-focus-within:visible group-hover:visible">
                                                <button
                                                    type="button"
                                                    onClick={() => setEditing(w.id)}
                                                    aria-label={`Rename ${w.name}`}
                                                    title="Rename"
                                                    className={action}
                                                >
                                                    <Pencil className="size-3" aria-hidden />
                                                </button>
                                                {w.id !== LOCAL_WORKSPACE && (
                                                    <button
                                                        type="button"
                                                        onClick={() => setRemoving(w)}
                                                        aria-label={`Delete ${w.name}`}
                                                        title="Delete"
                                                        className={action}
                                                    >
                                                        <Trash2 className="size-3" aria-hidden />
                                                    </button>
                                                )}
                                            </span>
                                        </span>
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                    <div className="mt-1 border-t border-border-soft pt-1">
                        {editing === 'new' ? (
                            <NameField initial="" onDone={created} />
                        ) : (
                            <button type="button" onClick={() => setEditing('new')} className={cn(item, 'w-full text-fg2')}>
                                <Plus className="size-3.5 flex-none" aria-hidden />
                                New workspace
                            </button>
                        )}
                    </div>
                </PopoverContent>
            </Popover>
            <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete {removing?.name}?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {removing && connectionsIn(removing.id) > 0
                                ? `Its ${count(connectionsIn(removing.id), 'connection')} move to Local. Its query tabs close. No database is touched.`
                                : 'Its query tabs close. No database is touched.'}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => removing && remove(removing)}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
