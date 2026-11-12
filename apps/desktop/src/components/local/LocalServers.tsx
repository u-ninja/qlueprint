import { useEffect, useState, type ReactNode } from 'react';
import { Eraser, Play, Plug, RotateCw, ScrollText, Square, Trash2 } from 'lucide-react';
import { commands, type LocalInstance } from '@/bindings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
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
import { StatusDot } from '@/components/shell/StatusDot';
import { errorMessage } from '@/stores/connections';
import { openInstance, statusDot, statusLabel, useLocal } from '@/stores/local';
import { engineName } from '@/lib/engines';
import { cn } from '@/lib/utils';

const LOG_LINES = 300;

const action =
    'grid size-6 place-items-center rounded text-fg3 outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40';

function IconButton({ label, onClick, disabled, children }: { label: string; onClick?: () => void; disabled?: boolean; children: ReactNode }) {
    return (
        <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className={action}>
            {children}
        </button>
    );
}

function Logs({ instance }: { instance: LocalInstance }) {
    const [text, setText] = useState<string | null>(null);
    const [error, setError] = useState('');
    const load = () => {
        setError('');
        commands.localDatabaseLogs(instance.id, LOG_LINES).then(setText, (e) => setError(errorMessage(e)));
    };
    return (
        <Dialog onOpenChange={(open) => open && load()}>
            <DialogTrigger asChild>
                <button type="button" aria-label={`Logs of ${instance.name}`} title="Logs" className={action}>
                    <ScrollText className="size-3.5" aria-hidden />
                </button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Logs of {instance.name}</DialogTitle>
                    <DialogDescription>The last {LOG_LINES} lines. Passwords are masked.</DialogDescription>
                </DialogHeader>
                {error ? (
                    <p role="alert" className="text-danger">
                        {error}
                    </p>
                ) : (
                    <pre className="h-96 overflow-auto rounded-md border border-border-soft bg-editor px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap select-text">
                        {text ?? 'Loading…'}
                    </pre>
                )}
                <Button variant="outline" className="w-fit" onClick={load}>
                    Refresh
                </Button>
            </DialogContent>
        </Dialog>
    );
}

function RemoveButton({ instance }: { instance: LocalInstance }) {
    const remove = useLocal((s) => s.remove);
    const docker = instance.provider === 'docker';
    return (
        <AlertDialog>
            <AlertDialogTrigger asChild>
                <button type="button" aria-label={`Remove ${instance.name}`} title="Remove" className={action}>
                    <Trash2 className="size-3.5" aria-hidden />
                </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Remove {instance.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                        {docker
                            ? `Removes the container ${instance.containerName}. The data stays in the volume ${instance.volume}; delete it separately.`
                            : instance.provider === 'native'
                              ? `QluePrint stops tracking it. The server stays installed${instance.uninstall ? `; to uninstall it: ${instance.uninstall}` : ''}.`
                              : 'QluePrint stops tracking it. The file stays where it is.'}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => void remove(instance.id).catch(() => {})}>
                        {docker ? 'Remove container' : 'Remove'}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

/** Deleting data can't be undone, so it takes the database name typed out */
function DeleteDataButton({ instance }: { instance: LocalInstance }) {
    const deleteData = useLocal((s) => s.deleteData);
    const [typed, setTyped] = useState('');
    const what = instance.provider === 'docker' ? `the volume ${instance.volume}` : `the file ${instance.dataPath}`;
    return (
        <AlertDialog onOpenChange={() => setTyped('')}>
            <AlertDialogTrigger asChild>
                <button
                    type="button"
                    aria-label={`Delete the data of ${instance.name}`}
                    title="Delete data"
                    className={cn(action, 'hover:text-danger')}
                >
                    <Eraser className="size-3.5" aria-hidden />
                </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Delete all data of {instance.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                        This deletes {what}
                        {instance.provider === 'docker' ? ' and its container' : ''}, and forgets the saved connection. It can’t be undone. Type{' '}
                        <strong className="font-mono">{instance.database}</strong> to confirm.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <Input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    aria-label="Database name to confirm"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                />
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                        variant="destructive"
                        disabled={typed !== instance.database}
                        onClick={() => void deleteData(instance.id, typed).catch(() => {})}
                    >
                        Delete data
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

function InstanceRow({ instance }: { instance: LocalInstance }) {
    const busy = useLocal((s) => s.busy[instance.id]);
    const error = useLocal((s) => s.errors[instance.id]);
    const lifecycle = useLocal((s) => s.lifecycle);
    const [openError, setOpenError] = useState('');
    const server = instance.provider !== 'file';
    const running = instance.status === 'running' || instance.status === 'starting';
    const removed = instance.status === 'removed';
    const meta = [engineName[instance.engine], instance.port != null ? `:${instance.port}` : 'file'].join(' ');
    const act = (a: 'start' | 'stop' | 'restart') => void lifecycle(instance.id, a).catch(() => {});

    return (
        <li className="group py-1">
            <div className="flex h-7 items-center gap-1.5 rounded-md px-1 hover:bg-hover">
                <span className="grid size-3.5 flex-none place-items-center" title={statusLabel[instance.status]}>
                    <StatusDot state={statusDot[instance.status]} />
                </span>
                <span className="sr-only">{statusLabel[instance.status]}</span>
                <span className="min-w-0 flex-1 truncate">{instance.name}</span>
                {busy ? (
                    <span role="status" className="font-mono text-[11px] text-fg4">
                        {busy}
                    </span>
                ) : (
                    <span className="font-mono text-[11px] text-fg4 group-focus-within:hidden group-hover:hidden">{meta}</span>
                )}
                {!busy && (
                    <span className="hidden items-center group-focus-within:flex group-hover:flex">
                        {server &&
                            !removed &&
                            (running ? (
                                <IconButton label={`Stop ${instance.name}`} onClick={() => act('stop')}>
                                    <Square className="size-3.5" aria-hidden />
                                </IconButton>
                            ) : (
                                <IconButton label={`Start ${instance.name}`} onClick={() => act('start')}>
                                    <Play className="size-3.5" aria-hidden />
                                </IconButton>
                            ))}
                        {server && !removed && (
                            <IconButton label={`Restart ${instance.name}`} onClick={() => act('restart')} disabled={!running}>
                                <RotateCw className="size-3.5" aria-hidden />
                            </IconButton>
                        )}
                        {instance.provider === 'docker' && !removed && <Logs instance={instance} />}
                        <IconButton
                            label={`Open ${instance.name} in the workspace`}
                            disabled={!instance.savedConnectionId || removed}
                            onClick={() => void openInstance(instance).catch((e) => setOpenError(errorMessage(e)))}
                        >
                            <Plug className="size-3.5" aria-hidden />
                        </IconButton>
                        {!removed && <RemoveButton instance={instance} />}
                        {instance.provider !== 'native' && <DeleteDataButton instance={instance} />}
                    </span>
                )}
            </div>
            {(error || openError) && (
                <p className="pr-1 pl-6 text-xs text-danger wrap-anywhere" role="alert">
                    {error || openError}
                </p>
            )}
            {removed && <p className="pl-6 text-xs text-fg3">Container removed. The data is kept in {instance.volume}.</p>}
        </li>
    );
}

/** The Local servers view: databases QluePrint created on this machine and their lifecycle */
export function LocalServers() {
    const { instances, loading, error, load, setCreateOpen } = useLocal();
    useEffect(() => {
        void load();
    }, [load]);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {instances.length > 0 && (
                <ul aria-label="Local databases" className="min-h-0 overflow-auto px-1.5">
                    {instances.map((i) => (
                        <InstanceRow key={i.id} instance={i} />
                    ))}
                </ul>
            )}
            <div className={cn('flex flex-col items-start gap-2 px-3.5 py-3', instances.length > 0 && 'mt-2 border-t border-border-soft')}>
                {instances.length === 0 && !loading && (
                    <p className="text-fg3">
                        Databases you create on this machine (Docker, native or SQLite) show up here with start, stop and logs.
                    </p>
                )}
                {error && (
                    <p role="alert" className="text-xs text-danger">
                        {error}
                    </p>
                )}
                <div className="flex gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                        Create local database
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
                        {loading ? 'Refreshing…' : 'Refresh'}
                    </Button>
                </div>
            </div>
        </div>
    );
}
