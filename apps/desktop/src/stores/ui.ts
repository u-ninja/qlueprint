import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { motion, setMotion, type Motion } from '@/lib/spring';

export type Theme = 'light' | 'dark' | 'system';
export type View = 'workspace' | 'connections' | 'servers' | 'queries' | 'history' | 'audit';

/** The table the inspector shows: picked with a single click in the explorer */
export type ResultsTab = 'results' | 'messages' | 'plan';

export type Inspected = { connectionId: string; database: string; schema: string; table: string };

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
            setTheme: (theme) => set({ theme }),
            setMotion: (motion) => set({ motion }),
            setView: (view) => set({ view, sidebarOpen: true }),
            toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
            toggleInspector: () => set((s) => (s.changesOpen ? { changesOpen: false, inspectorOpen: true } : { inspectorOpen: !s.inspectorOpen })),
            setChangesOpen: (changesOpen) => set({ changesOpen }),
            setResultsTab: (resultsTab) => set({ resultsTab }),
            inspect: (inspected) => set({ inspected, inspectorOpen: true }),
        }),
        {
            name: 'qc-ui',
            partialize: ({ theme, motion, view, sidebarOpen, inspectorOpen }) => ({ theme, motion, view, sidebarOpen, inspectorOpen }),
        },
    ),
);

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
