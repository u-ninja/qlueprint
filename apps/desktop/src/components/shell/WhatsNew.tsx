import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useUi } from '@/stores/ui';
import { isTauri, version } from '@/lib/utils';
import { releasesSince } from '@/lib/changelog';
import { ReleaseNotes } from './ReleaseNotes';

/** After an update, lists what changed once. Closing it (or an update with nothing listed) marks the version as seen */
export function WhatsNew() {
    const seen = useUi((s) => s.seenVersion);
    const setSeen = useUi((s) => s.setSeenVersion);
    const shown = isTauri && seen !== version ? releasesSince(seen) : [];

    return (
        <Dialog open={shown.length > 0} onOpenChange={(open) => !open && setSeen(version)}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <p className="font-mono text-[11px] font-medium text-primary-text">Updated{seen ? ` from ${seen}` : ''}</p>
                    <DialogTitle className="text-lg">What’s new in QluePrint {version}</DialogTitle>
                    <DialogDescription>Here’s what changed since you last opened it.</DialogDescription>
                </DialogHeader>
                <div className="-mx-4 flex max-h-[22rem] flex-col gap-5 overflow-y-auto px-4 py-1">
                    {shown.map((r, i) => (
                        <article key={r.version} className="flex flex-col gap-3">
                            {shown.length > 1 && (
                                <h3 className="flex items-center gap-2 font-mono text-[11px] font-medium text-fg3">
                                    {r.version}
                                    {i === 0 && <span className="rounded-full bg-primary-soft px-1.5 py-px text-primary-text">Latest</span>}
                                </h3>
                            )}
                            <ReleaseNotes changes={r.changes} />
                        </article>
                    ))}
                </div>
                <DialogFooter>
                    <Button size="sm" onClick={() => setSeen(version)}>
                        Got it
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
