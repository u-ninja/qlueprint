import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useUi } from '@/stores/ui';
import { isTauri, version } from '@/lib/utils';
import changelog from '../../../CHANGELOG.md?raw';

type Entry = { version: string; changes: string[] };

/** `## 0.1.9` headings, each followed by `- ` lines */
const entries: Entry[] = changelog
    .split(/^## /m)
    .slice(1)
    .map((block) => {
        const [heading, ...lines] = block.split('\n');
        return { version: heading.trim(), changes: lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()) };
    });

const parts = (v: string) => v.split('.').map(Number);
/** Negative when `a` is the older version */
function compare(a: string, b: string) {
    const [x, y] = [parts(a), parts(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The releases since the one last shown, up to the running one, newest first */
const sinceSeen = (seen: string | null) =>
    entries.filter((e) => compare(e.version, version) <= 0 && (!seen || compare(e.version, seen) > 0)).slice(0, 3);

/** After an update, lists what changed once. Closing it (or an update with nothing listed) marks the version as seen */
export function WhatsNew() {
    const seen = useUi((s) => s.seenVersion);
    const setSeen = useUi((s) => s.setSeenVersion);
    const shown = isTauri && seen !== version ? sinceSeen(seen) : [];

    return (
        <Dialog open={shown.length > 0} onOpenChange={(open) => !open && setSeen(version)}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>What’s new in QluePrint {version}</DialogTitle>
                    <DialogDescription>Changes since the version you last opened.</DialogDescription>
                </DialogHeader>
                <div className="flex max-h-80 flex-col gap-4 overflow-y-auto">
                    {shown.map((e) => (
                        <section key={e.version}>
                            <h3 className="pb-1.5 font-mono text-[11px] font-medium text-fg3">{e.version}</h3>
                            <ul className="flex list-disc flex-col gap-1.5 pl-4 text-[13px] marker:text-fg4">
                                {e.changes.map((c) => (
                                    <li key={c}>{c}</li>
                                ))}
                            </ul>
                        </section>
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
