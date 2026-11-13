import { useEffect } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
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
import { isDirty, useQuery } from '@/stores/query';
import { useUi } from '@/stores/ui';
import { checkForUpdates, installUpdate, useUpdates } from '@/stores/updates';
import { isTauri, version } from '@/lib/utils';

/** Unsaved SQL or table edits in any workspace: a restart drops them */
const unsaved = () => {
    const s = useQuery.getState();
    return [s, ...Object.values(s.parked)].some((w) => [...w.queries, ...w.tables].some(isDirty));
};

/**
 * Checks for a newer release at launch (release builds, unless turned off in Settings) and asks to
 * install it right away; after Later, the top-bar button stays to install it. Installing restarts
 * the app, after warning that a restart drops unsaved work. Also shows what a manual check found
 */
export function UpdateButton() {
    const { update, installOpen, notice, progress } = useUpdates(
        useShallow(({ update, installOpen, notice, progress }) => ({ update, installOpen, notice, progress })),
    );
    useEffect(() => {
        if (isTauri && import.meta.env.PROD && useUi.getState().checkUpdates) void checkForUpdates();
    }, []);

    const busy = typeof progress === 'number';
    const failed = typeof progress === 'string';
    const dirty = installOpen && unsaved();

    return (
        <>
            {update && (
                <Button
                    variant="secondary"
                    size="xs"
                    disabled={busy}
                    onClick={() => useUpdates.setState({ installOpen: true })}
                    title={failed ? `Update failed: ${progress}. Click to try again.` : `QluePrint ${update.version} is ready to install`}
                >
                    <ArrowDownToLine aria-hidden />
                    <span aria-live="polite">{busy ? `Updating… ${progress}%` : failed ? 'Update failed' : `Update to ${update.version}`}</span>
                </Button>
            )}
            <AlertDialog open={installOpen && !!update} onOpenChange={(installOpen) => useUpdates.setState({ installOpen })}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Install QluePrint {update?.version}?</AlertDialogTitle>
                        <AlertDialogDescription>
                            You have {version}. QluePrint downloads the update, then restarts.
                            {dirty && ' You have unsaved queries or table changes; they’re lost in the restart, so save them first.'}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    {update?.body && <p className="max-h-40 overflow-auto text-xs whitespace-pre-wrap text-fg3">{update.body}</p>}
                    <AlertDialogFooter>
                        <AlertDialogCancel>Later</AlertDialogCancel>
                        <AlertDialogAction variant={dirty ? 'destructive' : 'default'} onClick={() => void installUpdate()}>
                            {dirty ? 'Restart without saving' : 'Update and restart'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            <AlertDialog open={notice !== null} onOpenChange={(open) => !open && useUpdates.setState({ notice: null })}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{notice?.title}</AlertDialogTitle>
                        <AlertDialogDescription>{notice?.text}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogAction>OK</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
