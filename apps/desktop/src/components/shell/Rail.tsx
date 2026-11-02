import { Database, FileCode, History, LayoutGrid, PanelLeft, type LucideIcon } from "lucide-react";
import { useUi, type View } from "@/stores/ui";
import { cn } from "@/lib/utils";

export const views: { value: View; label: string; icon: LucideIcon }[] = [
  { value: "workspace", label: "Workspace", icon: LayoutGrid },
  { value: "connections", label: "Connections", icon: Database },
  { value: "queries", label: "Queries", icon: FileCode },
  { value: "history", label: "History", icon: History },
];

export function Rail() {
  const { view, sidebarOpen, setView, toggleSidebar } = useUi();

  return (
    <nav aria-label="Main" className="flex w-[68px] flex-none flex-col border-r border-border-soft bg-chrome py-2">
      {views.map(({ value, label, icon: Icon }) => {
        const active = view === value && sidebarOpen;
        return (
          <button
            key={value}
            aria-current={active ? "page" : undefined}
            onClick={() => setView(value)}
            className={cn(
              "mx-1.5 mb-1 flex flex-col items-center gap-1 rounded-lg py-2 text-[11px] text-fg3 hover:bg-hover hover:text-foreground",
              active && "bg-primary-soft text-primary-text hover:bg-primary-soft hover:text-primary-text",
            )}
          >
            <Icon className="size-[18px]" aria-hidden />
            {label}
          </button>
        );
      })}
      <button
        onClick={toggleSidebar}
        aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        className="mx-auto mt-auto grid size-8 place-items-center rounded-md text-fg3 hover:bg-hover hover:text-foreground"
      >
        <PanelLeft className="size-4" aria-hidden />
      </button>
    </nav>
  );
}
