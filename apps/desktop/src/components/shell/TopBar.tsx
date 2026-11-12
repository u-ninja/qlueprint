import { useLayoutEffect, useMemo, useRef } from 'react';
import { FilePen, Monitor, Moon, Search, Sun, type LucideIcon } from 'lucide-react';
import { useUi, type Theme } from '@/stores/ui';
import { auth } from '@/lib/auth';
import { cn, count, isMac, isTauri, saveShortcut, shortcutLabel } from '@/lib/utils';
import { Kbd } from '@/components/ui/kbd';
import { useSpring } from '@/lib/spring';
import { totalEdits, useQuery } from '@/stores/query';
import { AppMenu } from './AppMenu';
import { ConnectDialog } from './ConnectDialog';
import { createActions, useNativeMenu } from './menu';
import { WindowControls } from './WindowControls';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { CommandPalette } from './CommandPalette';
import mark from '@/assets/qlueprint-mark.svg';

const themes: { value: Theme; label: string; icon: LucideIcon }[] = [
    { value: 'light', label: 'Light theme', icon: Sun },
    { value: 'dark', label: 'Dark theme', icon: Moon },
    { value: 'system', label: 'Match system theme', icon: Monitor },
];

// Windows and Linux: the window has no OS title bar, so this draws the menu and window buttons.
// macOS: the native menu sits in the screen's menu bar and the traffic lights overlay the left edge.
const ownControls = isTauri && !isMac;

/** Unsaved table edits, everywhere: the count, and a click that shows or hides the Changes panel */
function ChangesButton() {
    // A primitive: a selector returning a new object each time would re-render on every store change
    const total = useQuery(totalEdits);
    const open = useUi((s) => s.changesOpen);
    const setChangesOpen = useUi((s) => s.setChangesOpen);
    const label = total ? count(total, 'unsaved change') : 'No unsaved changes';

    return (
        <button
            type="button"
            onClick={() => setChangesOpen(!open)}
            aria-label={`Changes: ${label}`}
            aria-pressed={open}
            title={total ? `${label} · ${saveShortcut} in a table also opens them` : label}
            className={cn(
                'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-[color,background-color,scale] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-97',
                // Pending edits: a light circles the edge and a reflection crosses the face (index.css)
                total ? 'changes-live text-foreground' : 'text-fg4 hover:bg-hover hover:text-fg2',
                open && 'ring-1 ring-warning',
            )}
        >
            {total > 0 && <span className="changes-sheen" aria-hidden />}
            <FilePen className="size-3.5" aria-hidden />
            Changes
            {total > 0 && <span className="font-mono text-[11px] tabular-nums">{total.toLocaleString()}</span>}
        </button>
    );
}

export function TopBar() {
    const { theme, setTheme } = useUi();
    const thumb = useRef<HTMLSpanElement>(null);
    const slideThumb = useSpring((x) => thumb.current && (thumb.current.style.transform = `translateX(${x}px)`));
    // Each option is 24px wide
    useLayoutEffect(() => {
        slideThumb(themes.findIndex((t) => t.value === theme) * 24);
    }, [theme, slideThumb]);
    const session = auth.useSession();
    const connectTrigger = useRef<HTMLButtonElement>(null);
    const actions = useMemo(() => createActions(() => connectTrigger.current?.click()), []);
    useNativeMenu(actions);

    return (
        // "deep": empty space and plain text anywhere in the bar drag the window; controls don't
        <header
            data-tauri-drag-region="deep"
            className={cn(
                'flex h-11 flex-none items-center gap-3 border-b border-border-soft bg-chrome pl-3.5 select-none',
                ownControls ? 'pr-0' : 'pr-2.5',
            )}
        >
            {/* Room for the traffic lights, placed by src-tauri/src/chrome.rs */}
            {isTauri && isMac && <div className="w-[58px] flex-none" aria-hidden />}
            <div className="flex flex-none items-center gap-2 font-semibold">
                {/* The app icon's mark, cropped to its tile (docs/brand/qlueprint-favicon.svg) */}
                <img src={mark} alt="" width={20} height={20} className="size-5" draggable={false} />
                QluePrint
            </div>
            {!isMac && <AppMenu actions={actions} />}
            <div className="h-[18px] w-px flex-none bg-border-soft" aria-hidden />
            <WorkspaceSwitcher />
            {!session.data && (
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg3">
                    <span className="size-1.5 flex-none rounded-full bg-fg4" aria-hidden />
                    <span className="truncate">Offline · No account required</span>
                </span>
            )}

            {/* Opens the command palette; centred in the space between the two sides */}
            <button
                type="button"
                onClick={() => useUi.getState().setPaletteOpen(true)}
                className="mx-auto flex h-7 w-[clamp(180px,calc(100vw-760px),400px)] min-w-0 items-center gap-2 rounded-md border border-border-soft bg-background pr-1.5 pl-2.5 text-[12.5px] text-fg3 transition-colors outline-none hover:border-border hover:text-fg2 focus-visible:ring-2 focus-visible:ring-ring/50"
            >
                <Search className="size-3.5 flex-none" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-left">Search tables, queries, commands…</span>
                <Kbd className="flex-none">{shortcutLabel('Ctrl+K')}</Kbd>
            </button>
            <CommandPalette actions={actions} />

            <div className={cn('flex flex-none items-center gap-2', ownControls && 'pr-1')}>
                <ChangesButton />
                {/* Toggle buttons, not radios: radios would need arrow-key roving focus */}
                <div role="group" aria-label="Theme" className="relative flex rounded-md bg-muted p-0.5">
                    <span ref={thumb} aria-hidden className="pointer-events-none absolute top-0.5 left-0.5 size-6 rounded bg-primary-soft" />
                    {themes.map(({ value, label, icon: Icon }) => (
                        <button
                            key={value}
                            type="button"
                            aria-pressed={theme === value}
                            aria-label={label}
                            title={label}
                            onClick={() => setTheme(value)}
                            className={cn(
                                'relative grid size-6 place-items-center rounded text-fg3 transition-colors hover:text-foreground',
                                theme === value && 'text-primary-text hover:text-primary-text',
                            )}
                        >
                            <Icon className="size-3.5" aria-hidden />
                        </button>
                    ))}
                </div>
                {/* shortcut: accounts are hidden until sign-in ships; put back <AccountButton /> to show it */}
            </div>
            {ownControls && <WindowControls />}
            {/* shortcut: File › New connection opens the dialog through this hidden trigger; give
          ConnectDialog open/onOpenChange props once the MySQL branch has landed */}
            <ConnectDialog>
                <button ref={connectTrigger} hidden tabIndex={-1} />
            </ConnectDialog>
        </header>
    );
}
