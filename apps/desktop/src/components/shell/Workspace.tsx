import { ChevronDown, Database, FileUp, PanelRight, Play, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { ConnectDialog } from "./ConnectDialog";
import { PendingAction } from "./PendingAction";

const startActions = [
  { icon: Database, title: "Connect to a database", detail: "PostgreSQL or SQLite.", connect: true },
  { icon: Server, title: "Create a local database", detail: "Set up a database server on this machine." },
  { icon: FileUp, title: "Open SQL file", detail: "Open an existing .sql file. No connection needed." },
];

const startActionClass =
  "h-auto w-full items-start justify-start gap-3 px-3 py-2.5 text-left font-normal whitespace-normal";

const runShortcut = navigator.userAgent.includes("Mac") ? "⌘ Enter" : "Ctrl + Enter";

export function Workspace() {
  const { inspectorOpen, toggleInspector } = useUi();

  return (
    <main className="flex h-full min-w-0 flex-col bg-editor">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-border-soft px-2.5">
        <PendingAction size="sm">
          <Play aria-hidden /> Run
        </PendingAction>
        <div className="ml-auto flex items-center gap-1.5">
          <PendingAction variant="outline" size="sm">
            Select a database <ChevronDown aria-hidden />
          </PendingAction>
          <button
            onClick={toggleInspector}
            aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
            aria-pressed={inspectorOpen}
            title={inspectorOpen ? "Hide inspector" : "Show inspector"}
            className={cn(
              "grid size-7 place-items-center rounded-md text-fg3 hover:bg-hover hover:text-foreground",
              inspectorOpen && "text-primary-text",
            )}
          >
            <PanelRight className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      <section aria-labelledby="welcome-title" className="grid flex-1 place-items-center overflow-auto p-6">
        <div className="w-full max-w-sm">
          <h1 id="welcome-title" className="text-lg font-semibold">
            Welcome to QueryCraft
          </h1>
          <p className="mt-1 text-fg3">Your database workspace is ready.</p>
          <ul className="mt-5 flex flex-col gap-1">
            {startActions.map(({ icon: Icon, title, detail, connect }) => {
              const content = (
                <>
                  <Icon className="mt-0.5 size-4 text-primary-text" aria-hidden />
                  <span>
                    <span className="block font-medium">{title}</span>
                    <span className="block text-fg3">{detail}</span>
                  </span>
                </>
              );
              return (
                <li key={title}>
                  {connect ? (
                    <ConnectDialog>
                      <Button variant="ghost" className={startActionClass}>
                        {content}
                      </Button>
                    </ConnectDialog>
                  ) : (
                    <PendingAction variant="ghost" wrapperClassName="flex" className={startActionClass}>
                      {content}
                    </PendingAction>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-5 text-xs text-fg3">
            <kbd className="rounded border border-border-soft bg-muted px-1.5 py-0.5 font-mono">{runShortcut}</kbd>{" "}
            Execute query
          </p>
        </div>
      </section>

      {/* Collapsed until there are results to show */}
      <div className="flex h-8 flex-none items-center border-t border-border-soft bg-surface px-3.5 text-fg3">
        Results
      </div>
    </main>
  );
}
