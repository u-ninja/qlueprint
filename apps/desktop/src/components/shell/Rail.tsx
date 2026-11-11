import { Database, FileCode, History, LayoutGrid, PanelLeft, ScrollText, Server, type LucideIcon } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { useSpring } from '@/lib/spring';
import { useUi, type View } from '@/stores/ui';
import { cn } from '@/lib/utils';

export const views: { value: View; label: string; icon: LucideIcon }[] = [
    { value: 'workspace', label: 'Workspace', icon: LayoutGrid },
    { value: 'connections', label: 'Connections', icon: Database },
    { value: 'servers', label: 'Local servers', icon: Server },
    { value: 'queries', label: 'Queries', icon: FileCode },
    { value: 'history', label: 'History', icon: History },
    { value: 'audit', label: 'Audit log', icon: ScrollText },
];

const railButton = 'text-fg3 hover:text-foreground';

export function Rail() {
    const { view, sidebarOpen, setView, toggleSidebar } = useUi();
    const nav = useRef<HTMLElement>(null);
    const bar = useRef<HTMLSpanElement>(null);
    const slide = useSpring((y) => bar.current && (bar.current.style.transform = `translateY(${y}px)`));
    useLayoutEffect(() => {
        const row = nav.current?.querySelector<HTMLElement>('[aria-current=page]')?.parentElement;
        if (bar.current) bar.current.style.opacity = row ? '1' : '0';
        // The bar is 20px tall, centred on the 36px row
        if (row) slide(row.offsetTop + 8);
    }, [view, sidebarOpen, slide]);

    return (
        <nav ref={nav} aria-label="Main" className="relative flex w-12 flex-none flex-col gap-1 border-r border-border-soft bg-chrome py-2">
            {/* The active view's 2px accent bar on the rail's left edge, springing between views */}
            <span ref={bar} aria-hidden className="pointer-events-none absolute top-0 left-0 h-5 w-0.5 rounded-r-full bg-primary opacity-0" />
            {views.map(({ value, label, icon: Icon }) => {
                const active = view === value && sidebarOpen;
                return (
                    <div key={value} className="flex justify-center">
                        <Button
                            variant="ghost"
                            size="icon-lg"
                            aria-current={active ? 'page' : undefined}
                            aria-label={label}
                            title={label}
                            onClick={() => setView(value)}
                            className={cn(railButton, active && 'bg-muted text-foreground hover:bg-muted')}
                        >
                            <Icon className="size-4.5" aria-hidden />
                        </Button>
                    </div>
                );
            })}
            <Button
                variant="ghost"
                size="icon-lg"
                onClick={toggleSidebar}
                aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
                title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
                className={cn(railButton, 'mx-auto mt-auto')}
            >
                <PanelLeft className="size-4" aria-hidden />
            </Button>
        </nav>
    );
}
