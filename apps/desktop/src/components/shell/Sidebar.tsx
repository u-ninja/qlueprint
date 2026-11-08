import { Plus, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConnections } from '@/stores/connections';
import { useUi, type View } from '@/stores/ui';
import { ConnectDialog } from './ConnectDialog';
import { Explorer } from './Explorer';
import { views } from './Rail';
import { LocalServers } from '@/components/local/LocalServers';
import { useLocal } from '@/stores/local';
import { cn } from '@/lib/utils';

const emptyText: Record<View, string> = {
    workspace: 'No connections yet. Connect to a database or create a local one to see it here.',
    connections: 'No saved connections.',
    servers: '',
    queries: 'No saved queries.',
    history: 'No queries run yet.',
    audit: 'Every connection and query, recorded on this machine. Passwords and result rows are never written to it, and each entry is chained by hash, so an edited log fails the integrity check.',
};

export function Sidebar() {
    const view = useUi((s) => s.view);
    const title = views.find((v) => v.value === view)?.label;
    const savedCount = useConnections((s) => s.saved.length);
    const setCreateOpen = useLocal((s) => s.setCreateOpen);
    // Both views list the saved connections; the others have nothing to list yet
    const listsConnections = view === 'workspace' || view === 'connections';
    const showExplorer = listsConnections && savedCount > 0;

    return (
        <aside aria-label={title} className="flex h-full flex-col bg-panel">
            <h2 className="flex h-10 flex-none items-center gap-2 px-3.5 font-medium">
                {title}
                {showExplorer && <span className="font-mono text-[11px] font-normal text-fg4 tabular-nums">{savedCount}</span>}
            </h2>
            {showExplorer && <Explorer />}
            {view === 'servers' && <LocalServers />}
            <div
                className={cn('flex flex-col gap-3 px-3.5 py-3', showExplorer && 'mt-2 border-t border-border-soft', view === 'servers' && 'hidden')}
            >
                {!showExplorer && <p className="text-fg3">{emptyText[view]}</p>}
                {listsConnections && (
                    <div className="flex flex-col items-start gap-1.5">
                        <ConnectDialog>
                            <Button variant="outline" size="sm">
                                <Plus aria-hidden /> New connection
                            </Button>
                        </ConnectDialog>
                        <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                            <Server aria-hidden /> Create local database
                        </Button>
                    </div>
                )}
            </div>
        </aside>
    );
}
