import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { motion, setMotion, type Motion } from '@/lib/spring';

export type Theme = 'light' | 'dark' | 'system';
export type View = 'workspace' | 'connections' | 'servers' | 'queries' | 'history' | 'audit';

/** The table the inspector shows: picked with a single click in the explorer */
export type ResultsTab = 'results' | 'messages' | 'plan';

export type Inspected = { connectionId: string; database: string; schema: string; table: string };

/** A local workspace, e.g. one per client: its own saved connections and query tabs */
export type WorkspaceInfo = { id: string; name: string };
/** Where connections without a placement live, so ones saved before workspaces existed stay put */
export const LOCAL_WORKSPACE = 'local';
const LOCAL: WorkspaceInfo = { id: LOCAL_WORKSPACE, name: 'Local' };

/** The workspace a saved connection is in */
export const workspaceOf = (placement: Record<string, string>, savedId: string) => placement[savedId] ?? LOCAL_WORKSPACE;

type UiState = {
    theme: Theme;
    motion: Motion;
    view: View;
    sidebarOpen: boolean;
    inspectorOpen: boolean;
    inspected: Inspected | null;
    /** The Changes panel: every table tab's unsaved edits. Shown in the inspector's place while open; not remembered */
    changesOpen: boolean;
    /** The results panel's tab; Explain shows the plan. Not remembered */
    resultsTab: ResultsTab;
    /** The columns a foreign key picker shows for each row of a table (`tableKey`), in order;
     * missing: the picker's own choice */
    lookupLabels: Record<string, string[]>;
    /** null goes back to the picker's own choice */
    setLookupLabels: (table: string, columns: string[] | null) => void;
    /** The command palette (⌘K, ⌘⇧P). Not remembered */
    paletteOpen: boolean;
    setPaletteOpen: (open: boolean) => void;
    setTheme: (theme: Theme) => void;
    setMotion: (motion: Motion) => void;
    setView: (view: View) => void;
    toggleSidebar: () => void;
    /** Also brings the inspector back while the Changes panel holds its place */
    toggleInspector: () => void;
    setChangesOpen: (open: boolean) => void;
    setResultsTab: (tab: ResultsTab) => void;
    /** Shows a table in the inspector, opening it */
    inspect: (target: Inspected) => void;
    /** Local first, then in the order made */
    workspaces: WorkspaceInfo[];
    /** The shown one; switch with the query store's switchWorkspace, which swaps the tabs too */
    workspace: string;
    /** Saved connection id → workspace id; missing means Local */
    placement: Record<string, string>;
    /** Adds a workspace and returns its id */
    createWorkspace: (name: string) => string;
    renameWorkspace: (id: string, name: string) => void;
    /** Takes it off the list; its connections move to Local. Not Local itself */
    removeWorkspace: (id: string) => void;
    moveConnection: (savedId: string, workspace: string) => void;
};

// Remembered between launches so the workspace reopens as the user left it
export const useUi = create<UiState>()(
    persist(
        (set) => ({
            theme: 'system',
            motion: 'spring',
            view: 'workspace',
            sidebarOpen: true,
            inspectorOpen: false,
            inspected: null,
            changesOpen: false,
            resultsTab: 'results',
            lookupLabels: {},
            setLookupLabels: (table, columns) =>
                set((s) => {
                    const { [table]: _, ...rest } = s.lookupLabels;
                    return { lookupLabels: columns ? { ...rest, [table]: columns } : rest };
                }),
            paletteOpen: false,
            setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
            setTheme: (theme) => set({ theme }),
            setMotion: (motion) => set({ motion }),
            setView: (view) => set({ view, sidebarOpen: true }),
            toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
            toggleInspector: () => set((s) => (s.changesOpen ? { changesOpen: false, inspectorOpen: true } : { inspectorOpen: !s.inspectorOpen })),
            setChangesOpen: (changesOpen) => set({ changesOpen }),
            setResultsTab: (resultsTab) => set({ resultsTab }),
            inspect: (inspected) => set({ inspected, inspectorOpen: true }),
            workspaces: [LOCAL],
            workspace: LOCAL_WORKSPACE,
            placement: {},
            createWorkspace: (name) => {
                const id = crypto.randomUUID();
                set((s) => ({ workspaces: [...s.workspaces, { id, name: name.trim() }] }));
                return id;
            },
            renameWorkspace: (id, name) => set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name: name.trim() } : w)) })),
            removeWorkspace: (id) =>
                set((s) =>
                    id === LOCAL_WORKSPACE
                        ? s
                        : {
                              workspaces: s.workspaces.filter((w) => w.id !== id),
                              placement: Object.fromEntries(Object.entries(s.placement).filter(([, w]) => w !== id)),
                          },
                ),
            moveConnection: (savedId, workspace) => set((s) => ({ placement: { ...s.placement, [savedId]: workspace } })),
        }),
        {
            name: 'qc-ui',
            partialize: ({ theme, motion, view, sidebarOpen, inspectorOpen, workspaces, workspace, placement, lookupLabels }) => ({
                theme,
                motion,
                view,
                sidebarOpen,
                inspectorOpen,
                workspaces,
                workspace,
                placement,
                lookupLabels,
            }),
        },
    ),
);

/** Whether a saved connection is in the shown workspace, outside React (stores, editor providers) */
export function inShownWorkspace(savedId: string) {
    const { placement, workspace } = useUi.getState();
    return workspaceOf(placement, savedId) === workspace;
}

/** Whether a saved connection is in the shown workspace; re-renders when the workspace or placement changes */
export function useInWorkspace() {
    const workspace = useUi((s) => s.workspace);
    const placement = useUi((s) => s.placement);
    return (savedId: string) => workspaceOf(placement, savedId) === workspace;
}

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

// Where the last click landed: a theme change reveals itself in a circle growing from there
let pointer = { x: 0, y: 0, at: 0 };
window.addEventListener('pointerdown', (e) => (pointer = { x: e.clientX, y: e.clientY, at: e.timeStamp }), true);

function applyTheme(reveal = false) {
    const { theme } = useUi.getState();
    const resolved = theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : theme;
    const root = document.documentElement;
    if (root.dataset.theme === resolved) return;
    if (!reveal || motion() === 'off' || !document.startViewTransition) {
        root.dataset.theme = resolved;
        return;
    }
    // A picked menu item or shortcut has no recent click: grow from the window's center
    const recent = performance.now() - pointer.at < 1000;
    const x = recent ? pointer.x : innerWidth / 2;
    const y = recent ? pointer.y : innerHeight / 2;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const transition = document.startViewTransition(() => {
        root.dataset.theme = resolved;
    });
    transition.ready
        .then(() =>
            root.animate(
                { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
                // The same spring curve as every other motion (src/lib/spring.ts)
                {
                    duration: 560,
                    easing: getComputedStyle(root).getPropertyValue('--spring-ease').trim(),
                    pseudoElement: '::view-transition-new(root)',
                },
            ),
        )
        .catch(() => {});
}

// Runs at import, before the first render, so the saved theme and motion apply without a flash
applyTheme();
setMotion(useUi.getState().motion);
useUi.subscribe((s, prev) => {
    if (s.theme !== prev.theme) applyTheme(true);
    if (s.motion !== prev.motion) setMotion(s.motion);
});
systemDark.addEventListener('change', () => applyTheme());
