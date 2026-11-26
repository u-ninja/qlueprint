import { useEffect } from 'react';
import { ArrowDownToLine, ArrowRight } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
    AlertDialog,
    AlertDialogAction,
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
import { parseChanges } from '@/lib/changelog';
import { ReleaseNotes } from './ReleaseNotes';

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
    const changes = parseChanges(update?.body ?? '');

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
            <Dialog open={installOpen && !!update} onOpenChange={(open) => !busy && useUpdates.setState({ installOpen: open })}>
                <DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
                    <DialogHeader>
                        <p className="font-mono text-[11px] font-medium text-primary-text">Update available</p>
                        <DialogTitle className="text-lg">QluePrint {update?.version}</DialogTitle>
                        <DialogDescription className="flex items-center gap-1.5 font-mono text-xs">
                            <span>{version}</span>
                            <ArrowRight className="size-3" aria-hidden />
                            <span className="text-fg">{update?.version}</span>
                        </DialogDescription>
                    </DialogHeader>
                    <div className="-mx-4 max-h-[20rem] overflow-y-auto px-4 py-1">
                        {changes.length > 0 ? (
                            <ReleaseNotes changes={changes} />
                        ) : (
                            <p className="text-[13px] text-fg3">No release notes were published for this version.</p>
                        )}
                    </div>
                    {dirty && (
                        <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-fg2" role="alert">
                            You have unsaved queries or table changes. They’re lost in the restart, so save them first.
                        </p>
                    )}
                    {failed && (
                        <p className="rounded-md bg-danger-soft px-3 py-2 text-xs text-fg2" role="alert">
                            Update failed: {progress}. Check your connection and try again.
                        </p>
                    )}
                    {busy ? (
                        <div className="flex flex-col gap-2" aria-live="polite">
                            <div
                                role="progressbar"
                                aria-label="Downloading the update"
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={progress}
                                className="h-1.5 overflow-hidden rounded-full bg-muted"
                            >
                                <div
                                    className="h-full origin-left rounded-full bg-primary transition-transform duration-200 motion-reduce:transition-none"
                                    style={{ transform: `scaleX(${progress / 100})` }}
                                />
                            </div>
                            <p className="font-mono text-xs text-fg3">
                                {progress < 100 ? `Downloading ${progress}%` : 'Installing, then restarting…'}
                            </p>
                        </div>
                    ) : (
                        <DialogFooter>
                            <Button variant="outline" size="sm" onClick={() => useUpdates.setState({ installOpen: false })}>
                                Later
                            </Button>
                            <Button size="sm" variant={dirty ? 'destructive' : 'default'} onClick={() => void installUpdate()}>
                                {failed ? 'Try again' : dirty ? 'Restart without saving' : 'Update and restart'}
                            </Button>
                        </DialogFooter>
                    )}
                </DialogContent>
            </Dialog>
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
