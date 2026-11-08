import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'system';
export type View = 'workspace' | 'connections' | 'queries' | 'history' | 'audit';

type UiState = {
    theme: Theme;
    view: View;
    sidebarOpen: boolean;
    inspectorOpen: boolean;
    setTheme: (theme: Theme) => void;
    setView: (view: View) => void;
    toggleSidebar: () => void;
    toggleInspector: () => void;
};

// Remembered between launches so the workspace reopens as the user left it
export const useUi = create<UiState>()(
    persist(
        (set) => ({
            theme: 'system',
            view: 'workspace',
            sidebarOpen: true,
            inspectorOpen: false,
            setTheme: (theme) => set({ theme }),
            setView: (view) => set({ view, sidebarOpen: true }),
            toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
            toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
        }),
        {
            name: 'qc-ui',
            partialize: ({ theme, view, sidebarOpen, inspectorOpen }) => ({ theme, view, sidebarOpen, inspectorOpen }),
        },
    ),
);

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
    const { theme } = useUi.getState();
    const resolved = theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : theme;
    document.documentElement.dataset.theme = resolved;
}

// Runs at import, before the first render, so the saved theme shows without a flash
applyTheme();
useUi.subscribe(applyTheme);
systemDark.addEventListener('change', applyTheme);
