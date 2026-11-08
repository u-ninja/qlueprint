import { Database, FileCode, History, LayoutGrid, PanelLeft, ScrollText, Server, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

    return (
        <nav aria-label="Main" className="flex w-12 flex-none flex-col gap-1 border-r border-border-soft bg-chrome py-2">
            {views.map(({ value, label, icon: Icon }) => {
                const active = view === value && sidebarOpen;
                return (
                    // Full-width row, so the active view's 2px accent bar sits on the rail's left edge
                    <div
                        key={value}
                        className={cn(
                            'relative flex justify-center',
                            active && 'before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-r-full before:bg-primary',
                        )}
                    >
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
