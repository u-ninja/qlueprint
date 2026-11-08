import { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { Kbd } from '@/components/ui/kbd';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useConnections } from '@/stores/connections';
import { activeConnection, summary, useQuery, type Outcome } from '@/stores/query';
import { ResultsGrid } from './ResultsGrid';
import { cn, runShortcut } from '@/lib/utils';

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// Ticks on its own so only this label re-renders while a query runs
function Elapsed({ since }: { since: number }) {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 100);
        return () => clearInterval(timer);
    }, []);
    // aria-hidden: inside a live region, a 100 ms tick would be read out continuously
    return (
        <span className="font-mono tabular-nums" aria-hidden>
            {((now - since) / 1000).toFixed(1)} s
        </span>
    );
}

function Spinner() {
    return <span className="size-3.5 animate-spin rounded-full border-[1.8px] border-border border-t-primary" aria-hidden />;
}

function Running({ since }: { since: number }) {
    const connectionId = useQuery((s) => s.connectionId);
    const label = useConnections((s) => activeConnection(s.connections, connectionId)?.label);
    return (
        <div role="status" className="grid h-full place-items-center text-fg3">
            <span className="flex items-center gap-2.5">
                <Spinner />
                Executing on {label}… <Elapsed since={since} />
            </span>
        </div>
    );
}

function Empty() {
    return (
        <div className="grid h-full place-items-center text-fg3">
            <div className="flex flex-col items-center gap-2">
                <span>Run a query to see results here</span>
                <span className="text-xs">
                    <Kbd className="px-1.5 font-mono text-fg2">{runShortcut}</Kbd> runs the query, or just the selected part
                </span>
            </div>
        </div>
    );
}

function Failed({ error }: { error: string }) {
    return (
        <div role="alert" className="flex gap-3 overflow-auto px-5 py-4.5">
            <CircleAlert className="mt-px size-4 flex-none text-danger" aria-hidden />
            <div className="flex min-w-0 flex-col gap-1.5">
                <span className="font-medium">Query failed</span>
                <span className="font-mono text-xs wrap-anywhere whitespace-pre-wrap text-fg2">{error}</span>
            </div>
        </div>
    );
}

function OutcomeView({ outcome }: { outcome: Outcome }) {
    if (!outcome.ok) return <Failed error={outcome.error} />;
    const { output } = outcome;
    if (output.columns.length) return <ResultsGrid output={output} />;
    return <div className="grid h-full place-items-center text-fg3">{summary(output)}</div>;
}

function ResultsView() {
    const runningSince = useQuery((s) => s.runningSince);
    const last = useQuery((s) => s.last);

    if (!last) return runningSince === null ? <Empty /> : <Running since={runningSince} />;
    return (
        // The previous result stays visible but dimmed until the new one returns; the tab strip says so
        <div className={cn('h-full', runningSince !== null && 'opacity-50')}>
            <OutcomeView outcome={last} />
        </div>
    );
}

/** Right side of the tab strip: what's running, or what the shown result is */
function Status() {
    const runningSince = useQuery((s) => s.runningSince);
    const last = useQuery((s) => s.last);
    if (runningSince !== null)
        return (
            <span role="status" className="flex items-center gap-2">
                <Spinner /> {last ? 'Running, showing previous result' : 'Running'} · <Elapsed since={runningSince} />
            </span>
        );
    return last?.ok ? <span className="font-mono text-[11px] tabular-nums">{summary(last.output)}</span> : null;
}

function MessagesView() {
    const messages = useQuery((s) => s.messages);
    if (!messages.length) return <div className="grid h-full place-items-center text-fg3">No messages yet</div>;
    return (
        <ol className="h-full overflow-auto py-2 font-mono text-xs select-text">
            {messages.map((m, i) => (
                <li key={i} className="flex items-baseline gap-3.5 px-4 py-1">
                    <span className="flex-none text-fg4 tabular-nums">{time.format(m.at)}</span>
                    <span className={cn('w-11 flex-none', m.ok ? 'text-success' : 'text-danger')}>{m.ok ? 'OK' : 'ERROR'}</span>
                    <span className="min-w-0 whitespace-pre-wrap text-fg2">{m.text}</span>
                </li>
            ))}
        </ol>
    );
}

const tab = 'flex-none px-0.5 text-[13px]';

export function ResultsPanel() {
    return (
        <Tabs defaultValue="results" className="h-full gap-0 bg-surface">
            <div className="flex h-10 flex-none items-center gap-4 border-b border-border-soft pr-4 text-xs text-fg3">
                <TabsList variant="line" className="h-full flex-none justify-start gap-4 rounded-none px-4 py-0">
                    <TabsTrigger value="results" className={tab}>
                        Results
                    </TabsTrigger>
                    <TabsTrigger value="messages" className={tab}>
                        Messages
                    </TabsTrigger>
                    <TabsTrigger value="plan" className={tab} disabled title="Not built yet">
                        Plan
                    </TabsTrigger>
                </TabsList>
                <div className="ml-auto min-w-0 truncate">
                    <Status />
                </div>
            </div>
            <TabsContent value="results" className="min-h-0">
                <ResultsView />
            </TabsContent>
            <TabsContent value="messages" className="min-h-0">
                <MessagesView />
            </TabsContent>
        </Tabs>
    );
}
