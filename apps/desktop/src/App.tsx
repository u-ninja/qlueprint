import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
    useDefaultLayout,
    type GroupImperativeHandle,
    type Layout,
    type LayoutChangedMeta,
    type PanelImperativeHandle,
} from 'react-resizable-panels';
import { TableInspector } from '@/components/inspector/TableInspector';
import { ChangesPanel } from '@/components/workspace/ChangesPanel';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Rail } from '@/components/shell/Rail';
import { Sidebar } from '@/components/shell/Sidebar';
import { TopBar } from '@/components/shell/TopBar';
import { Workspace } from '@/components/shell/Workspace';
import { AuditLog } from '@/components/audit/AuditLog';
import { StatusDot } from '@/components/shell/StatusDot';
import { CreateLocalDialog } from '@/components/local/CreateLocalDialog';
import { closedState, useConnections } from '@/stores/connections';
import { useUi } from '@/stores/ui';
import { clamp01, Enter, useSpring } from '@/lib/spring';
import { cn } from '@/lib/utils';
// The release this build is, as the updater compares it
import { version } from '../package.json';

type Side = 'sidebar' | 'inspector';
const sides: Side[] = ['sidebar', 'inspector'];
const panelIds = ['sidebar', 'main', 'inspector'];

type Shared = {
    group: RefObject<GroupImperativeHandle | null>;
    main: RefObject<HTMLDivElement | null>;
    /** Each side's last open size, % of the group: where it reopens to, and what a closed side saves as */
    openPct: RefObject<Partial<Record<Side, number>>>;
    /** How far each side is from its layout size this frame, in %: the main panel takes it up */
    lag: RefObject<Record<Side, number>>;
};

/**
 * A side panel that springs open and shut. It stays mounted as a collapsible Panel; the library's
 * layout jumps once (resize at the start of opening, collapse at the end of closing) and in between
 * the spring writes flex-grow on this panel and the main one, keeping their sum fixed so only the
 * main area reflows and every frame ends on the values React already holds
 */
function SidePanel({
    id,
    side,
    open,
    defaultSize,
    contentKey,
    shared,
    onDragClosed,
    children,
}: {
    id: Side;
    side: 'left' | 'right';
    open: boolean;
    /** px, used until the panel has a remembered size */
    defaultSize: number;
    /** A new key while open slides the new content in without moving the panel */
    contentKey?: string;
    shared: Shared;
    /** The handle dragged (or Enter pressed on it) past the panel's minimum: it collapsed on its own */
    onDragClosed: () => void;
    children: ReactNode;
}) {
    const panel = useRef<PanelImperativeHandle>(null);
    const el = useRef<HTMLDivElement>(null);
    const box = useRef<HTMLDivElement>(null);
    const run = useRef<{ size: number } | null>(null);
    // The state the panel last came to rest in: content stays rendered until a close settles
    const [rest, setRest] = useState(open);
    const [initialSize] = useState(() => (open ? defaultSize : 0));
    const first = useRef(true);

    const spring = useSpring(
        (p, done) => {
            const r = run.current;
            const content = box.current;
            const panelEl = el.current;
            const main = shared.main.current;
            if (!r || !content || !panelEl || !main) return;
            if (done) {
                run.current = null;
                if (p === 0) panel.current?.collapse();
                content.style.cssText = '';
                (content.parentElement as HTMLElement).style.overflow = 'auto';
                setRest(p === 1);
            } else {
                content.style.opacity = String(clamp01(p));
                content.style.transform = `translateX(${(1 - p) * (side === 'left' ? -16 : 16)}px)`;
            }
            // Width can't overshoot without pushing the main area past its layout; the slide above carries the bounce
            const grow = done ? (p === 1 ? r.size : 0) : r.size * clamp01(p);
            const lag = shared.lag.current;
            lag[id] = done ? 0 : r.size - grow;
            panelEl.style.flexGrow = String(grow);
            main.style.flexGrow = String((shared.group.current?.getLayout().main ?? 0) + lag.sidebar + lag.inspector);
        },
        { eps: 0.001 },
    );

    useLayoutEffect(() => {
        const g = shared.group.current;
        const panelEl = el.current;
        const content = box.current;
        // The first call only snaps the spring: the panel mounted at its size
        if (first.current || !g || !panelEl || !content) {
            first.current = false;
            spring(open ? 1 : 0);
            return;
        }
        const pct = shared.openPct.current[id];
        if (open) panel.current?.resize(pct === undefined ? defaultSize : `${pct}%`);
        const size = g.getLayout()[id] ?? 0;
        const panels = [...(panelEl.parentElement?.children ?? [])].filter((c) => c.hasAttribute('data-panel')) as HTMLElement[];
        const px = (panels.reduce((n, c) => n + c.offsetWidth, 0) * size) / 100;
        run.current = { size };
        // Content keeps its open width while the panel's edge passes over it, so nothing rewraps per frame
        content.style.width = `${px}px`;
        (content.parentElement as HTMLElement).style.overflow = 'hidden';
        spring(open ? 1 : 0);
    }, [open]); // Only a change of open starts a move

    const handle = <ResizableHandle className={cn('bg-border-soft', !open && !rest && 'invisible')} disabled={!open} />;
    return (
        <>
            {side === 'right' && handle}
            <ResizablePanel
                id={id}
                panelRef={panel}
                elementRef={el}
                collapsible
                defaultSize={initialSize}
                minSize={id === 'sidebar' ? 200 : 240}
                maxSize={480}
                // The sidebar's content is pinned to its moving right edge, like a drawer
                className={cn('flex', side === 'left' && 'justify-end')}
                onResize={(size) => {
                    if (size.asPercentage === 0 && open && !run.current) onDragClosed();
                }}
            >
                {/* inert: a closing panel can't be focused or read, and a closed one has nothing in it */}
                <div ref={box} inert={!open} className="h-full w-full flex-none">
                    {(open || rest) && (
                        <Enter key={contentKey} x={side === 'left' ? -16 : 16} skip={!(open && rest)} className="h-full">
                            {children}
                        </Enter>
                    )}
                </div>
            </ResizablePanel>
            {side === 'left' && handle}
        </>
    );
}

// Opens straight into the workspace: no welcome screen, no sign-in wall, no loading screen
function App() {
    const sidebarOpen = useUi((s) => s.sidebarOpen);
    const view = useUi((s) => s.view);
    // One slot on the right: Changes stands in for the inspector while open, so the editor keeps its width
    const right = useUi((s) => (s.changesOpen ? 'changes' : s.inspectorOpen ? 'inspector' : null));
    // What the right slot last showed, so a closing panel keeps its content until it's shut
    const [shown, setShown] = useState(right ?? 'inspector');
    if (right && right !== shown) setShown(right);
    const connections = useConnections((s) => s.connections);
    const failed = useConnections((s) => Object.values(s.closed).filter((c) => closedState(c) === 'failed').length);
    const status = connections.length === 0 ? 'No connection' : connections.length === 1 ? connections[0].label : `${connections.length} open`;
    // Saves panel sizes to localStorage so they come back on the next launch
    const layout = useDefaultLayout({ id: 'qc-workspace', panelIds, storage: localStorage });
    const shared: Shared = {
        group: useRef<GroupImperativeHandle>(null),
        main: useRef<HTMLDivElement>(null),
        openPct: useRef({}),
        lag: useRef({ sidebar: 0, inspector: 0 }),
    };
    // Saved layouts hold every side at its open size; a side closed at launch starts collapsed, its share given to main
    const [initialLayout] = useState(() => {
        const saved = layout.defaultLayout;
        if (!saved) return undefined;
        const open = { sidebar: sidebarOpen, inspector: right !== null };
        const next = { ...saved };
        for (const id of sides) {
            if (!(next[id] > 0)) return undefined;
            shared.openPct.current[id] = next[id];
            if (!open[id]) {
                next.main += next[id];
                next[id] = 0;
            }
        }
        return next;
    });
    const onLayoutChanged = (l: Layout, meta: LayoutChangedMeta) => {
        const next = { ...(meta.requestedLayout ?? l) };
        for (const id of sides) {
            const pct = shared.openPct.current[id];
            if (next[id] > 0) shared.openPct.current[id] = next[id];
            else if (pct) {
                next.main -= pct;
                next[id] = pct;
            }
        }
        layout.onLayoutChanged(next, { ...meta, requestedLayout: next });
    };

    return (
        <div className="flex h-full flex-col">
            <TopBar />
            <div className="flex min-h-0 flex-1">
                <Rail />
                <ResizablePanelGroup orientation="horizontal" groupRef={shared.group} defaultLayout={initialLayout} onLayoutChanged={onLayoutChanged}>
                    <SidePanel
                        id="sidebar"
                        side="left"
                        open={sidebarOpen}
                        defaultSize={264}
                        shared={shared}
                        onDragClosed={() => useUi.setState({ sidebarOpen: false })}
                    >
                        <Sidebar />
                    </SidePanel>
                    <ResizablePanel id="main" elementRef={shared.main} minSize={360}>
                        {/* The audit log needs the width for its columns and SQL; every other view keeps the editor here */}
                        {view === 'audit' ? <AuditLog /> : <Workspace />}
                    </ResizablePanel>
                    <SidePanel
                        id="inspector"
                        side="right"
                        open={right !== null}
                        defaultSize={shown === 'changes' ? 340 : 300}
                        contentKey={shown}
                        shared={shared}
                        onDragClosed={() => useUi.setState({ changesOpen: false, inspectorOpen: false })}
                    >
                        {shown === 'changes' ? <ChangesPanel /> : <TableInspector />}
                    </SidePanel>
                </ResizablePanelGroup>
            </div>
            <footer className="flex h-6 flex-none items-center gap-4 border-t border-border-soft bg-chrome px-3 text-[11.5px] text-fg3">
                {/* One line at any width: a long label truncates (full text on hover) instead of wrapping */}
                <span className="flex min-w-0 items-center gap-1.5" title={status}>
                    <StatusDot state={connections.length ? 'open' : 'closed'} />
                    <span className="truncate">{status}</span>
                </span>
                {failed > 0 && (
                    <span className="flex flex-none items-center gap-1.5">
                        <StatusDot state="failed" />
                        {failed} failed
                    </span>
                )}
                <span className="ml-auto flex-none">Local · v{version}</span>
            </footer>
            {/* Opened from the sidebar, the welcome screen and Local servers */}
            <CreateLocalDialog />
        </div>
    );
}

export default App;
