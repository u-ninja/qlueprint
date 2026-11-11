import { Fragment, lazy, Suspense } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import { Database, FileCode2, FileUp, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { QueryToolbar } from '@/components/workspace/QueryToolbar';
import { ResultsPanel, TableResults } from '@/components/workspace/ResultsPanel';
import { useConnections } from '@/stores/connections';
import { useQuery } from '@/stores/query';
import { useLocal } from '@/stores/local';
import { cn, newQueryShortcut, runShortcut, shortcutLabel } from '@/lib/utils';
import { ConnectDialog } from './ConnectDialog';
import { PendingAction } from './PendingAction';
import { SheetTabs } from './SheetTabs';

// Monaco is most of the app's JavaScript; the welcome screen doesn't need it
const SqlEditor = lazy(() => import('@/components/workspace/SqlEditor'));

const startActions = [
    { icon: Database, title: 'Connect to a database', detail: 'PostgreSQL, MySQL or SQLite.', connect: true },
    { icon: Server, title: 'Create a local database', detail: 'PostgreSQL, MySQL or MariaDB in Docker, or a SQLite file.', local: true },
    { icon: FileUp, title: 'Open SQL file', detail: 'Open an existing .sql file. No connection needed.' },
];

const startActionClass = 'h-auto w-full items-start justify-start gap-3 px-3 py-2.5 text-left font-normal whitespace-normal';

function Welcome() {
    const setCreateOpen = useLocal((s) => s.setCreateOpen);
    return (
        <section aria-labelledby="welcome-title" className="grid flex-1 place-items-center overflow-auto p-6">
            <div className="w-full max-w-sm">
                <h1 id="welcome-title" className="text-lg font-medium">
                    Connect a database to start
                </h1>
                <p className="mt-1 text-fg3">
                    QueryCraft runs on this machine. Connections and drafts stay here, passwords go to your system’s credential store.
                </p>
                <ul className="mt-5 flex flex-col gap-1">
                    {startActions.map(({ icon: Icon, title, detail, connect, local }) => {
                        const content = (
                            <>
                                <Icon className="mt-0.5 size-4 text-fg3" aria-hidden />
                                <span>
                                    <span className="block font-medium">{title}</span>
                                    <span className="block text-fg3">{detail}</span>
                                </span>
                            </>
                        );
                        return (
                            <li key={title}>
                                {connect ? (
                                    <ConnectDialog>
                                        <Button variant="ghost" className={startActionClass}>
                                            {content}
                                        </Button>
                                    </ConnectDialog>
                                ) : local ? (
                                    <Button variant="ghost" className={startActionClass} onClick={() => setCreateOpen(true)}>
                                        {content}
                                    </Button>
                                ) : (
                                    <PendingAction variant="ghost" wrapperClassName="flex" className={startActionClass}>
                                        {content}
                                    </PendingAction>
                                )}
                            </li>
                        );
                    })}
                </ul>
                <p className="mt-5 text-xs text-fg3">
                    <Kbd className="px-1.5 font-mono text-fg2">{runShortcut}</Kbd> runs the query
                </p>
            </div>
        </section>
    );
}

function EditorAndResults() {
    // Saves the editor/results split so it comes back on the next launch
    const layout = useDefaultLayout({ id: 'qc-editor', panelIds: ['editor', 'results'], storage: localStorage });
    return (
        <ResizablePanelGroup
            orientation="vertical"
            defaultLayout={layout.defaultLayout}
            onLayoutChanged={layout.onLayoutChanged}
            className="min-h-0 flex-1"
        >
            <ResizablePanel id="editor" minSize={120}>
                <Suspense>
                    <SqlEditor />
                </Suspense>
            </ResizablePanel>
            <ResizableHandle className="bg-border-soft" />
            <ResizablePanel id="results" defaultSize="40%" minSize={80}>
                <ResultsPanel />
            </ResizablePanel>
        </ResizablePanelGroup>
    );
}

const shortcuts: [string, string][] = [
    ['New query', newQueryShortcut],
    ['Run the query', runShortcut],
    ['Find in results', shortcutLabel('Ctrl+F')],
    ['Close the tab', shortcutLabel('Ctrl+W')],
];

/** No tab open, like an editor with every file closed: what to do next, and the keys for it */
function NothingOpen() {
    const newQuery = useQuery((s) => s.newQuery);
    return (
        <section aria-label="No open tabs" className="grid flex-1 place-items-center p-6">
            <div className="flex w-full max-w-xs flex-col items-center gap-5 text-center">
                <Button variant="outline" onClick={newQuery}>
                    <FileCode2 aria-hidden /> New query
                </Button>
                <dl className="grid w-full grid-cols-[1fr_auto] gap-x-6 gap-y-2.5 text-left text-fg3">
                    {shortcuts.map(([what, keys]) => (
                        <Fragment key={what}>
                            <dt>{what}</dt>
                            <dd>
                                <Kbd className="px-1.5 font-mono text-fg2">{keys}</Kbd>
                            </dd>
                        </Fragment>
                    ))}
                    <dt>Open a table’s rows</dt>
                    <dd className="text-fg2">double-click it</dd>
                </dl>
            </div>
        </section>
    );
}

export function Workspace() {
    const noConnections = useConnections((s) => s.saved.length === 0);
    const noTabs = useQuery((s) => s.queries.length === 0 && s.tables.length === 0);
    const query = useQuery((s) => s.queries.some((q) => q.id === s.activeTab));
    const table = useQuery((s) => s.tables.find((t) => t.id === s.activeTab));
    const hasQueries = useQuery((s) => s.queries.length > 0);

    // Nothing open and nothing connected: the welcome says how to start
    if (noConnections && noTabs)
        return (
            <main className="flex h-full min-w-0 flex-col overflow-hidden bg-editor">
                <Welcome />
            </main>
        );

    return (
        <main className="flex h-full min-w-0 flex-col overflow-hidden bg-editor">
            {!noTabs && <SheetTabs />}
            {/* Hidden, not unmounted, behind a table tab: the editor keeps its cursor, scroll and undo history */}
            {hasQueries && (
                <div className={cn('flex min-h-0 flex-1 flex-col', !query && 'hidden')}>
                    <QueryToolbar />
                    <EditorAndResults />
                </div>
            )}
            {table && <TableResults tab={table} />}
            {!query && !table && <NothingOpen />}
        </main>
    );
}
