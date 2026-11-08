import { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { Kbd } from '@/components/ui/kbd';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useConnections } from '@/stores/connections';
import { activeConnection, summary, useQuery, type Outcome } from '@/stores/query';
import { ResultsGrid } from './ResultsGrid';
import { cn, runShortcut } from '@/lib/utils';

// Figures and meta in the tab strip: the running timer and, once done, the result summary in its place
const meta = 'font-mono text-[11px] tabular-nums';

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const seconds = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// Ticks on its own so only this label re-renders while a query runs
function Elapsed({ since }: { since: number }) {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 100);
        return () => clearInterval(timer);
    }, []);
    // aria-hidden: inside a live region, a 100 ms tick would be read out continuously.
    // Right-aligned in a fixed width, so 9.9 s becoming 10.0 s doesn't shift the label beside it
    return (
        <span className={cn(meta, 'inline-block min-w-[6ch] text-right whitespace-nowrap')} aria-hidden>
            {`${seconds.format((now - since) / 1000)}\u00a0s`}
        </span>
    );
}

/** A thin accent segment sweeping along the bottom edge of the tab strip, i.e. the top of the results */
function RunningBar() {
    return (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden">
            {/* Reduced motion: the segment stops and becomes a static full-width line */}
            <div className="h-full w-1/4 animate-sweep bg-primary motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-60" />
        </div>
    );
}

// Quiet on purpose: the bar is the motion and the strip has the timer, the center only says where
function Running() {
    const connectionId = useQuery((s) => s.connectionId);
    const label = useConnections((s) => activeConnection(s.connections, connectionId)?.label);
    return (
        <div className="grid h-full place-items-center px-6 text-fg3">
            <span className="max-w-full truncate" title={label}>
                Running on {label}…
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

    if (!last) return runningSince === null ? <Empty /> : <Running />;
    return (
        // The previous result stays visible but dims until the new one returns; the tab strip says so.
        // The dim waits 300 ms so a quick re-run swaps the result without the grid flashing, and lifts at once
        <div className={cn('h-full transition-opacity duration-200', runningSince !== null && 'opacity-50 delay-300')}>
            <OutcomeView outcome={last} />
        </div>
    );
}

/** Right side of the tab strip: what's running, or what the shown result is */
function Status() {
    const runningSince = useQuery((s) => s.runningSince);
    const last = useQuery((s) => s.last);
    if (runningSince !== null) {
        const text = last ? 'Running, previous result shown' : 'Running…';
        return (
            <span role="status" className="flex items-baseline gap-2 whitespace-nowrap">
                <span className="min-w-0 truncate" title={text}>
                    {text}
                </span>
                <Elapsed since={runningSince} />
            </span>
        );
    }
    return last?.ok ? <span className={meta}>{summary(last.output)}</span> : null;
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
    const running = useQuery((s) => s.runningSince !== null);
    return (
        <Tabs defaultValue="results" className="h-full gap-0 bg-surface">
            <div className="relative flex h-10 flex-none items-center gap-4 border-b border-border-soft pr-4 text-xs text-fg3">
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
                {running && <RunningBar />}
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
