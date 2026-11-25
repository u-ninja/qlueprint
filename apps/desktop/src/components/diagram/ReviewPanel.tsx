import { X } from 'lucide-react';
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
import type { Connection } from '@/stores/connections';
import { useDiagram } from '@/stores/diagram';
import { changeSql, describeChange, destroysData } from '@/lib/schema-ddl';
import { count } from '@/lib/utils';

/** The staged edits as SQL, in the order they will run: nothing reaches the database until Apply */
export function ReviewPanel({ kind, schema }: { kind: Connection['kind']; schema: string }) {
    const changes = useDiagram((s) => s.changes);
    const applying = useDiagram((s) => s.applying);
    const unstage = useDiagram((s) => s.unstage);
    const discard = useDiagram((s) => s.discard);
    const apply = useDiagram((s) => s.apply);
    if (!changes.length) return null;

    const destructive = changes.filter(destroysData);
    const run = () => void apply();
    // One button; a change that deletes data wraps it in a confirmation
    const applyButton = (onClick?: () => void) => (
        <Button size="xs" disabled={applying} onClick={onClick}>
            {applying ? 'Applying…' : 'Apply'}
        </Button>
    );
    return (
        <section aria-label="Pending changes" className="flex max-h-[40%] min-h-0 flex-none flex-col border-t border-border bg-chrome">
            <div className="flex h-9 flex-none items-center gap-2 px-3">
                <h2 className="text-[13px] font-medium">{count(changes.length, 'pending change')}</h2>
                <span className="text-xs text-fg3">Nothing runs until you apply</span>
                <div className="ml-auto flex items-center gap-1.5">
                    <Button variant="ghost" size="xs" disabled={applying} onClick={discard}>
                        Discard all
                    </Button>
                    {destructive.length ? (
                        <AlertDialog>
                            <AlertDialogTrigger asChild>{applyButton()}</AlertDialogTrigger>
                            <AlertDialogContent>
                                <AlertDialogHeader>
                                    <AlertDialogTitle>Apply changes that delete data?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                        {destructive.map(describeChange).join(', ')}. The data in {destructive.length === 1 ? 'it' : 'them'} can’t be
                                        brought back.
                                        {kind === 'mysql' &&
                                            ' MySQL can’t undo a schema change, so one that fails part-way leaves the earlier ones in place.'}
                                    </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction variant="destructive" onClick={run}>
                                        Apply
                                    </AlertDialogAction>
                                </AlertDialogFooter>
                            </AlertDialogContent>
                        </AlertDialog>
                    ) : (
                        applyButton(run)
                    )}
                </div>
            </div>
            <ol className="min-h-0 flex-1 overflow-auto border-t border-border-soft">
                {changes.map((c) => (
                    <li key={c.id} className="group/change flex items-start gap-2 border-b border-border-soft px-3 py-1.5 last:border-b-0">
                        <div className="min-w-0 flex-1">
                            <p className="text-[13px]">{describeChange(c)}</p>
                            <pre className="mt-0.5 overflow-x-auto font-mono text-[11.5px] leading-snug text-fg3">{changeSql(kind, schema, c)}</pre>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            disabled={applying}
                            aria-label={`Remove: ${describeChange(c)}`}
                            onClick={() => unstage(c.id)}
                        >
                            <X aria-hidden />
                        </Button>
                    </li>
                ))}
            </ol>
        </section>
    );
}
