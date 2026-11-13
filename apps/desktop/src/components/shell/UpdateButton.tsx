import { useEffect, useState } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
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
import { isDirty, useQuery } from '@/stores/query';
import { errorMessage } from '@/stores/connections';
import { isTauri } from '@/lib/utils';

/** Unsaved SQL or table edits in any workspace: a restart drops them */
const unsaved = () => {
    const s = useQuery.getState();
    return [s, ...Object.values(s.parked)].some((w) => [...w.queries, ...w.tables].some(isDirty));
};

/**
 * Shown once a newer release is on GitHub (checked at launch, release builds only): installs it
 * and restarts the app, after asking, since a restart drops unsaved work
 */
export function UpdateButton() {
    const [update, setUpdate] = useState<Update | null>(null);
    // null: not started; a number: percent downloaded; a string: why it failed
    const [progress, setProgress] = useState<number | string | null>(null);
    const [dirty, setDirty] = useState(false);

    useEffect(() => {
        if (!isTauri || !import.meta.env.PROD) return;
        // Offline or GitHub down: no button, nothing to say
        check().then(setUpdate, () => {});
    }, []);

    if (!update) return null;

    const install = async () => {
        setProgress(0);
        let total = 0;
        let done = 0;
        try {
            await update.downloadAndInstall((e) => {
                if (e.event === 'Started') total = e.data.contentLength ?? 0;
                else if (e.event === 'Progress' && total) {
                    done += e.data.chunkLength;
                    setProgress(Math.round((done / total) * 100));
                }
            });
            await relaunch();
        } catch (error) {
            setProgress(errorMessage(error));
        }
    };
    const busy = typeof progress === 'number';

    return (
        <AlertDialog onOpenChange={(open) => open && setDirty(unsaved())}>
            <AlertDialogTrigger asChild>
                <Button
                    variant="secondary"
                    size="xs"
                    disabled={busy}
                    title={
                        typeof progress === 'string'
                            ? `Update failed: ${progress}. Click to try again.`
                            : `QluePrint ${update.version} is ready to install`
                    }
                >
                    <ArrowDownToLine aria-hidden />
                    <span aria-live="polite">
                        {busy ? `Updating… ${progress}%` : typeof progress === 'string' ? 'Update failed' : `Update to ${update.version}`}
                    </span>
                </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Install QluePrint {update.version}?</AlertDialogTitle>
                    <AlertDialogDescription>
                        QluePrint downloads the update, then restarts.
                        {dirty && ' You have unsaved queries or table changes; they’re lost in the restart, so save them first.'}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {update.body && <p className="max-h-40 overflow-auto text-xs whitespace-pre-wrap text-fg3">{update.body}</p>}
                <AlertDialogFooter>
                    <AlertDialogCancel>Later</AlertDialogCancel>
                    <AlertDialogAction variant={dirty ? 'destructive' : 'default'} onClick={() => void install()}>
                        {dirty ? 'Restart without saving' : 'Update and restart'}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
