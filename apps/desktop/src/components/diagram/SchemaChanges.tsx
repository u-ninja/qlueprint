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
import { changeSql, describeChange, destroysData } from '@/lib/schema-ddl';
import { targetKey, type Target } from '@/lib/schema-graph';
import { count } from '@/lib/utils';
import { useConnections } from '@/stores/connections';
import { changesOf, useSchemaEdit } from '@/stores/schema-edit';

/** One schema's staged edits as SQL, in the order they will run: nothing reaches the database until Apply */
export function SchemaChanges({ target, heading = true }: { target: Target; heading?: boolean }) {
    const kind = useConnections((s) => s.connections.find((c) => c.id === target.connectionId)?.kind);
    const changes = useSchemaEdit((s) => changesOf(s, target));
    const error = useSchemaEdit((s) => s.errors[targetKey(target)]);
    const applying = useSchemaEdit((s) => s.applying !== null);
    const { unstage, discard, apply } = useSchemaEdit.getState();
    if (!kind || !changes.length) return null;

    const destructive = changes.filter(destroysData);
    const run = () => void apply(target);
    // One button; a change that deletes data wraps it in a confirmation
    const applyButton = (onClick?: () => void) => (
        <Button size="xs" disabled={applying} onClick={onClick}>
            {applying ? 'Applying…' : 'Apply'}
        </Button>
    );
    return (
        <section aria-label={`Pending changes to ${target.schema}`} className="flex min-h-0 flex-col">
            <div className="flex min-h-9 flex-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1">
                <h2 className="text-[13px] font-medium">
                    {count(changes.length, 'schema change')}
                    {heading && <span className="font-normal text-fg3"> in {target.schema}</span>}
                </h2>
                <span className="text-xs text-fg3">Nothing runs until you apply</span>
                <div className="ml-auto flex items-center gap-1.5">
                    <Button variant="ghost" size="xs" disabled={applying} onClick={() => discard(target)}>
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
            {error && (
                <p role="alert" className="border-t border-border-soft bg-danger-soft px-3 py-1.5 text-[13px] text-danger">
                    {error}
                </p>
            )}
            <ol className="min-h-0 flex-1 overflow-auto border-t border-border-soft">
                {changes.map((c) => (
                    <li key={c.id} className="flex items-start gap-2 border-b border-border-soft px-3 py-1.5 last:border-b-0">
                        <div className="min-w-0 flex-1">
                            <p className="text-[13px]">{describeChange(c)}</p>
                            <pre className="mt-0.5 overflow-x-auto font-mono text-[11.5px] leading-snug text-fg3">
                                {changeSql(kind, target.schema, c)}
                            </pre>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            disabled={applying}
                            aria-label={`Remove: ${describeChange(c)}`}
                            onClick={() => unstage(target, c.id)}
                        >
                            <X aria-hidden />
                        </Button>
                    </li>
                ))}
            </ol>
        </section>
    );
}
