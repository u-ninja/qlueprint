import { useMemo, useRef, type PointerEvent } from 'react';
import { AlignLeft, Gauge, ListTree, PanelRight, Play, Square } from 'lucide-react';
import { formatEditor, formatShortcut } from '@/lib/format-editor';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PendingAction } from '@/components/shell/PendingAction';
import { StatusDot } from '@/components/shell/StatusDot';
import { useConnections } from '@/stores/connections';
import { activeConnection, activeDatabase, currentQuery, rerunnable, useQuery } from '@/stores/query';
import { useUi } from '@/stores/ui';
import { engineName, hasDatabases } from '@/lib/engines';
import { cn, explainAnalyzeShortcut, explainShortcut, runShortcut } from '@/lib/utils';
import { motion, useSpring2 } from '@/lib/spring';

// Fixed trigger widths so switching to a long label never shifts the toolbar; the menu may grow
// past its trigger up to a cap, and long labels truncate (full text in `title`)
const menu = 'max-w-80 min-w-(--radix-select-trigger-width)';

function ConnectionPicker() {
    const connections = useConnections((s) => s.connections);
    const connectionId = useQuery((s) => currentQuery(s).connectionId);
    const setConnectionId = useQuery((s) => s.setConnectionId);
    const active = activeConnection(connections, connectionId);

    return (
        <Select value={active?.id ?? ''} onValueChange={setConnectionId} disabled={!active}>
            <SelectTrigger size="sm" aria-label="Connection to run on" title={active?.label} className="w-56 min-w-28">
                <StatusDot state={active ? 'open' : 'closed'} />
                {/* Just the label: the default would copy the item's two-line content */}
                <SelectValue placeholder="No connection">{active?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" align="end" className={menu}>
                <SelectGroup>
                    <SelectLabel>Run on</SelectLabel>
                    {connections.map((c) => (
                        <SelectItem key={c.id} value={c.id} title={c.label} className="py-1.5">
                            <span className="flex min-w-0 flex-col gap-px">
                                <span className="truncate">{c.label}</span>
                                <span className="text-[11px] text-fg3">{engineName[c.kind]}</span>
                            </span>
                        </SelectItem>
                    ))}
                </SelectGroup>
            </SelectContent>
        </Select>
    );
}

/**
 * MySQL switches with USE; Postgres switches only with "Show all databases" on (each database gets
 * its own pool); SQLite has one. A picker that can't switch shows its database disabled, so the
 * toolbar keeps its layout when switching connections
 */
function DatabasePicker() {
    const connections = useConnections((s) => s.connections);
    const connectionId = useQuery((s) => currentQuery(s).connectionId);
    const picked = useQuery((s) => currentQuery(s).database);
    const setDatabase = useQuery((s) => s.setDatabase);
    const active = activeConnection(connections, connectionId);
    if (!active) return null;
    const { switchable } = active;
    const database = activeDatabase(active, { connectionId, database: picked }) || undefined;

    return (
        <Select value={database ?? ''} onValueChange={setDatabase} disabled={!switchable}>
            <SelectTrigger
                size="sm"
                aria-label="Database to run in"
                title={
                    switchable
                        ? database
                        : hasDatabases(active.kind)
                          ? 'Turn on “Show all databases” for this connection to switch'
                          : `${engineName[active.kind]} has one database`
                }
                className="w-40 min-w-24"
            >
                {/* Explicit: Radix only shows a value that matches an item, and a disabled picker has none */}
                <SelectValue placeholder={switchable ? 'No database' : 'Default database'}>{database}</SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" align="end" className={menu}>
                <SelectGroup>
                    <SelectLabel>Database</SelectLabel>
                    {switchable &&
                        active.databases.map((name) => (
                            <SelectItem key={name} value={name} title={name}>
                                <span className="truncate">{name}</span>
                            </SelectItem>
                        ))}
                </SelectGroup>
            </SelectContent>
        </Select>
    );
}

/** Explain, and Explain analyze, which runs the query, so only for one read statement. Secondary toolbar
 * actions: icon only when the toolbar is narrow, the label stays as their name */
function ExplainActions() {
    const explain = useQuery((s) => s.explain);
    const busy = useQuery((s) => currentQuery(s).plan?.runningSince != null);
    const hasSql = useQuery((s) => /\S/.test(currentQuery(s).sql));
    const connected = useConnections((s) => s.connections.length > 0);
    // shortcut: re-checked on edits, not on selection moves, so a stale answer is possible; the backend refuses writes either way
    const sql = useQuery((s) => currentQuery(s).sql);
    const hasSelection = useQuery((s) => s.hasSelection);
    const readOnly = useMemo(() => rerunnable((hasSelection && useQuery.getState().readSelection()) || sql), [sql, hasSelection]);
    const disabled = busy || !hasSql || !connected;
    const analyzeTitle = readOnly
        ? `Explain analyze: runs the query for real timings and row counts (${explainAnalyzeShortcut})`
        : 'Explain analyze runs the query, so it only works on a single read statement (SELECT, WITH…)';
    return (
        <>
            <Button
                variant="ghost"
                size="sm"
                onClick={(e) => void explain(e.shiftKey && readOnly)}
                disabled={disabled}
                aria-label="Explain"
                title={`Show how the database would run the query, without running it (${explainShortcut})`}
            >
                <ListTree aria-hidden /> <span className="hidden @3xl:inline">Explain</span>
            </Button>
            {/* Disabled buttons ignore hover, so the reason sits on a wrapper */}
            <span title={analyzeTitle} className="inline-flex">
                <Button variant="ghost" size="sm" onClick={() => void explain(true)} disabled={disabled || !readOnly} aria-label="Explain analyze">
                    <Gauge aria-hidden /> <span className="hidden @3xl:inline">Analyze</span>
                </Button>
            </span>
        </>
    );
}

function InspectorToggle() {
    // The Changes panel holds the inspector's place while open
    const inspectorOpen = useUi((s) => s.inspectorOpen && !s.changesOpen);
    const toggleInspector = useUi((s) => s.toggleInspector);
    const label = inspectorOpen ? 'Hide inspector' : 'Show inspector';
    return (
        <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleInspector}
            aria-label={label}
            aria-pressed={inspectorOpen}
            title={label}
            className={cn('text-fg3', inspectorOpen && 'text-primary-text')}
        >
            <PanelRight className="size-4" aria-hidden />
        </Button>
    );
}

/** Drifts the Run button up to 4px toward the pointer and springs it back when the pointer leaves */
function useMagnetic() {
    const button = useRef<HTMLButtonElement>(null);
    const [looseX, looseY] = useSpring2(
        (x, y) => {
            if (button.current) button.current.style.transform = `translate(${x}px, ${y}px)`;
        },
        { variant: 'magnetic' },
    );
    const pull = (e: PointerEvent<HTMLElement>) => {
        const el = button.current;
        if (!el || el.disabled || motion() === 'off') return;
        const r = el.getBoundingClientRect();
        const clamp = (n: number) => Math.max(-4, Math.min(4, n));
        looseX(clamp((e.clientX - (r.left + r.width / 2)) * 0.18));
        looseY(clamp((e.clientY - (r.top + r.height / 2)) * 0.28));
    };
    const release = () => {
        looseX(0);
        looseY(0);
    };
    return { button, pull, release };
}

export function QueryToolbar() {
    const magnet = useMagnetic();
    const running = useQuery((s) => currentQuery(s).runningSince !== null);
    const hasSelection = useQuery((s) => s.hasSelection);
    const hasSql = useQuery((s) => /\S/.test(currentQuery(s).sql));
    const connected = useConnections((s) => s.connections.length > 0);
    const run = useQuery((s) => s.run);

    return (
        // A container: on a narrow window the secondary actions drop their labels and the pickers
        // shrink, so the toolbar never pushes the editor wider than its panel
        <div className="@container flex h-11 flex-none items-center gap-1 border-b border-border-soft px-2.5">
            {/* The padding widens the area that pulls the button, without moving the layout */}
            <div className="-m-1.5 p-1.5" onPointerMove={magnet.pull} onPointerLeave={magnet.release}>
                <Button ref={magnet.button} size="sm" onClick={() => void run()} disabled={running || !hasSql || !connected} title={runShortcut}>
                    <Play aria-hidden /> {hasSelection ? 'Run selection' : 'Run'}
                </Button>
            </div>
            {/* shortcut: Stop isn't built yet; replace with the real action when it lands */}
            <PendingAction variant="ghost" size="sm" aria-label="Stop">
                <Square aria-hidden /> <span className="hidden @3xl:inline">Stop</span>
            </PendingAction>
            <ExplainActions />
            <Button
                variant="ghost"
                size="sm"
                onClick={() => void formatEditor()}
                disabled={!hasSql}
                aria-label="Format"
                title={`Format the query, or just the selection (${formatShortcut})`}
            >
                <AlignLeft aria-hidden /> <span className="hidden @3xl:inline">Format</span>
            </Button>
            <div className="ml-auto flex min-w-0 items-center gap-1.5">
                <ConnectionPicker />
                <DatabasePicker />
                <InspectorToggle />
            </div>
        </div>
    );
}
