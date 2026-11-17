import { useEffect, useState } from 'react';
import { CirclePlay, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Run, Schedule_Serialize as Schedule } from '@/bindings';
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
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { StatusDot } from '@/components/shell/StatusDot';
import { useConnections } from '@/stores/connections';
import { currentQuery, useQuery } from '@/stores/query';
import { useSchedules } from '@/stores/schedules';
import { count } from '@/lib/utils';

const POLL_MS = 5000;
const UNITS = [
    { label: 'Minutes', minutes: 1 },
    { label: 'Hours', minutes: 60 },
    { label: 'Days', minutes: 1440 },
];

/** "every 2 hours", "every minute" */
function every(minutes: number) {
    const unit = [...UNITS].reverse().find((u) => minutes % u.minutes === 0) ?? UNITS[0];
    const n = minutes / unit.minutes;
    const word = unit.label.toLowerCase().slice(0, -1);
    return n === 1 ? `every ${word}` : `every ${n.toLocaleString()} ${word}s`;
}

const when = (at: number) => new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

function RunLine({ run }: { run: Run }) {
    return (
        <li className="flex items-baseline gap-2 text-xs">
            <span className={run.ok ? 'text-success' : 'text-danger'}>{run.ok ? 'Succeeded' : 'Failed'}</span>
            <span className="tabular-nums text-fg3">{when(run.at)}</span>
            <span className="font-mono text-fg4 tabular-nums">
                {run.ok ? `${count(run.rows, 'row')} · ` : ''}
                {run.durationMs.toLocaleString()}&nbsp;ms
            </span>
            {run.error && (
                <span className="min-w-0 truncate text-danger" title={run.error}>
                    {run.error}
                </span>
            )}
        </li>
    );
}

function ScheduleRow({ schedule: s, onEdit }: { schedule: Schedule; onEdit: () => void }) {
    const { save, remove, runNow } = useSchedules.getState();
    const connection = useConnections((c) => c.saved.find((x) => x.id === s.connectionId));
    const last = s.history[s.history.length - 1];
    return (
        <li className="flex flex-col gap-2 border-b border-border-soft py-4 last:border-b-0">
            <div className="flex items-center gap-3">
                <StatusDot state={s.running ? 'connecting' : last ? (last.ok ? 'open' : 'failed') : 'closed'} />
                <div className="min-w-0 flex-1">
                    <h3 className="truncate font-medium">{s.name}</h3>
                    <p className="truncate text-xs text-fg3">
                        {connection?.label ?? 'Connection removed'}
                        {s.database ? ` · ${s.database}` : ''} · {every(s.everyMinutes)}
                    </p>
                </div>
                <Switch
                    checked={s.enabled}
                    aria-label={`${s.name} enabled`}
                    onCheckedChange={(enabled) =>
                        void save({
                            id: s.id,
                            name: s.name,
                            connectionId: s.connectionId,
                            database: s.database,
                            sql: s.sql,
                            everyMinutes: s.everyMinutes,
                            enabled,
                        })
                    }
                />
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Run ${s.name} now`}
                    title="Run now"
                    disabled={s.running}
                    onClick={() => void runNow(s.id)}
                >
                    <CirclePlay aria-hidden />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Edit ${s.name}`} title="Edit" onClick={onEdit}>
                    <Pencil aria-hidden />
                </Button>
                <AlertDialog>
                    <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${s.name}`} title="Delete">
                            <Trash2 aria-hidden />
                        </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Delete “{s.name}”?</AlertDialogTitle>
                            <AlertDialogDescription>
                                It stops running and its run history is removed. Audit entries of past runs stay.
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction variant="destructive" onClick={() => void remove(s.id)}>Delete</AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </div>
            <pre className="max-h-16 overflow-hidden rounded-md surface-recessed px-2.5 py-1.5 font-mono text-xs text-fg2">{s.sql}</pre>
            {s.history.length > 0 && (
                <ul className="flex flex-col gap-1">
                    {s.history
                        .slice(-3)
                        .reverse()
                        .map((run) => (
                            <RunLine key={run.at} run={run} />
                        ))}
                </ul>
            )}
        </li>
    );
}

type Draft = { id: string | null; name: string; connectionId: string; database: string; sql: string; amount: number; unit: number; enabled: boolean };

function ScheduleDialog({ draft, onClose }: { draft: Draft | null; onClose: () => void }) {
    const saved = useConnections((c) => c.saved);
    const error = useSchedules((s) => s.error);
    const [form, setForm] = useState<Draft | null>(draft);
    const [prev, setPrev] = useState(draft);
    // Reset when another schedule (or a new one) is opened
    if (draft !== prev) {
        setPrev(draft);
        setForm(draft);
    }
    if (!form) return null;
    const set = (change: Partial<Draft>) => setForm({ ...form, ...change });
    const minutes = form.amount * form.unit;
    const valid = form.name.trim() && form.sql.trim() && form.connectionId && form.amount >= 1;

    async function submit() {
        if (!form || !valid) return;
        const ok = await useSchedules.getState().save({
            id: form.id,
            name: form.name,
            connectionId: form.connectionId,
            database: form.database.trim() || null,
            sql: form.sql,
            everyMinutes: minutes,
            enabled: form.enabled,
        });
        if (ok) onClose();
    }

    return (
        <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{form.id ? 'Edit schedule' : 'New schedule'}</DialogTitle>
                    <DialogDescription>Runs the query on its own while QluePrint is running, and keeps the last few results here.</DialogDescription>
                </DialogHeader>
                <form
                    className="grid gap-3"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void submit();
                    }}
                >
                    <div className="grid gap-1.5">
                        <Label htmlFor="schedule-name">Name</Label>
                        <Input
                            id="schedule-name"
                            value={form.name}
                            onChange={(e) => set({ name: e.target.value })}
                            autoComplete="off"
                            spellCheck={false}
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-1.5">
                            <Label htmlFor="schedule-connection">Connection</Label>
                            <Select value={form.connectionId} onValueChange={(connectionId) => set({ connectionId })}>
                                <SelectTrigger id="schedule-connection" className="w-full">
                                    <SelectValue placeholder="Pick one" />
                                </SelectTrigger>
                                <SelectContent position="popper">
                                    {saved.map((c) => (
                                        <SelectItem key={c.id} value={c.id}>
                                            {c.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="schedule-database">Database</Label>
                            <Input
                                id="schedule-database"
                                value={form.database}
                                onChange={(e) => set({ database: e.target.value })}
                                placeholder="The connection’s own"
                                autoComplete="off"
                                spellCheck={false}
                            />
                        </div>
                    </div>
                    <div className="grid gap-1.5">
                        <Label htmlFor="schedule-sql">Query</Label>
                        <textarea
                            id="schedule-sql"
                            value={form.sql}
                            onChange={(e) => set({ sql: e.target.value })}
                            rows={5}
                            spellCheck={false}
                            className="w-full resize-y rounded-md border surface-recessed px-2.5 py-1.5 font-mono text-[13px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25"
                        />
                    </div>
                    <div className="flex items-end gap-3">
                        <div className="grid gap-1.5">
                            <Label htmlFor="schedule-every">Run every</Label>
                            <Input
                                id="schedule-every"
                                type="number"
                                min={1}
                                value={form.amount}
                                onChange={(e) => set({ amount: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
                                className="w-24 tabular-nums"
                            />
                        </div>
                        <Select value={String(form.unit)} onValueChange={(unit) => set({ unit: Number(unit) })}>
                            <SelectTrigger aria-label="Unit" className="w-28">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent position="popper">
                                {UNITS.map((u) => (
                                    <SelectItem key={u.minutes} value={String(u.minutes)}>
                                        {u.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Label className="ml-auto h-8 gap-2 font-normal">
                            <Switch checked={form.enabled} onCheckedChange={(enabled) => set({ enabled })} />
                            Enabled
                        </Label>
                    </div>
                    {error && (
                        <p role="alert" className="text-xs text-danger">
                            {error}
                        </p>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="outline" size="sm" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" size="sm" disabled={!valid}>
                            Save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Queries that run on a timer, with their last runs */
export function SchedulesPage() {
    const list = useSchedules((s) => s.list);
    const error = useSchedules((s) => s.error);
    const saved = useConnections((c) => c.saved);
    const [draft, setDraft] = useState<Draft | null>(null);

    // The engine runs in the background, so the page asks again while it is open
    useEffect(() => {
        void useSchedules.getState().load();
        const timer = setInterval(() => void useSchedules.getState().load(), POLL_MS);
        return () => clearInterval(timer);
    }, []);

    const create = () => {
        const tab = currentQuery(useQuery.getState());
        useSchedules.setState({ error: null });
        setDraft({
            id: null,
            name: '',
            connectionId: tab.connectionId ?? saved[0]?.id ?? '',
            database: '',
            sql: tab.sql,
            amount: 1,
            unit: 60,
            enabled: true,
        });
    };
    const edit = (s: Schedule) => {
        const unit = [...UNITS].reverse().find((u) => s.everyMinutes % u.minutes === 0) ?? UNITS[0];
        useSchedules.setState({ error: null });
        setDraft({
            id: s.id,
            name: s.name,
            connectionId: s.connectionId,
            database: s.database ?? '',
            sql: s.sql,
            amount: s.everyMinutes / unit.minutes,
            unit: unit.minutes,
            enabled: s.enabled,
        });
    };

    return (
        <main aria-label="Schedules" className="h-full min-w-0 overflow-y-auto bg-editor">
            <div className="max-w-3xl px-8 pt-4 pb-8">
                <div className="flex items-center justify-between gap-3 pb-2">
                    <p className="text-fg3">Closing the window keeps these running from the tray while any schedule is enabled.</p>
                    <Button size="sm" onClick={create} disabled={saved.length === 0} className="flex-none">
                        <Plus aria-hidden /> New schedule
                    </Button>
                </div>
                {error && !draft && (
                    <p role="alert" className="pb-2 text-xs text-danger">
                        {error}
                    </p>
                )}
                {list.length === 0 ? (
                    <p className="py-16 text-center text-fg3">
                        {saved.length === 0
                            ? 'Save a connection first, then schedule a query on it.'
                            : 'No schedules yet. The new one starts from the query in your editor.'}
                    </p>
                ) : (
                    <ul>
                        {list.map((s) => (
                            <ScheduleRow key={s.id} schedule={s} onEdit={() => edit(s)} />
                        ))}
                    </ul>
                )}
            </div>
            <ScheduleDialog draft={draft} onClose={() => setDraft(null)} />
        </main>
    );
}
