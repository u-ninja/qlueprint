import { lazy, Suspense } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { Database, FileUp, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { QueryToolbar } from "@/components/workspace/QueryToolbar";
import { ResultsPanel } from "@/components/workspace/ResultsPanel";
import { useConnections } from "@/stores/connections";
import { useQuery } from "@/stores/query";
import { runShortcut } from "@/lib/utils";
import { ConnectDialog } from "./ConnectDialog";
import { PendingAction } from "./PendingAction";

// Monaco is most of the app's JavaScript; the welcome screen doesn't need it
const SqlEditor = lazy(() => import("@/components/workspace/SqlEditor"));

const startActions = [
  { icon: Database, title: "Connect to a database", detail: "PostgreSQL, MySQL or SQLite.", connect: true },
  { icon: Server, title: "Create a local database", detail: "Set up a database server on this machine." },
  { icon: FileUp, title: "Open SQL file", detail: "Open an existing .sql file. No connection needed." },
];

const startActionClass =
  "h-auto w-full items-start justify-start gap-3 px-3 py-2.5 text-left font-normal whitespace-normal";

function Welcome() {
  return (
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
          <Kbd className="px-1.5 font-mono text-fg2">{runShortcut}</Kbd>{" "}
          Execute query
        </p>
      </div>
    </section>
  );
}

function EditorAndResults() {
  // Saves the editor/results split so it comes back on the next launch
  const layout = useDefaultLayout({ id: "qc-editor", panelIds: ["editor", "results"], storage: localStorage });
  return (
    <ResizablePanelGroup
      orientation="vertical"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
      className="min-h-0 flex-1"
    >
      <ResizablePanel id="editor" minSize={120}>
        <Suspense>
          <SqlEditor />
        </Suspense>
      </ResizablePanel>
      <ResizableHandle className="bg-border-soft" />
      <ResizablePanel id="results" defaultSize="40%" minSize={80}>
        <ResultsPanel />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export function Workspace() {
  // The welcome is the empty editor's state: it gives way once a connection is saved or a query drafted
  const noConnections = useConnections((s) => s.saved.length === 0);
  const noDraft = useQuery((s) => s.sql === "");
  const showWelcome = noConnections && noDraft;

  return (
    <main className="flex h-full min-w-0 flex-col bg-editor">
      <QueryToolbar />
      {showWelcome ? (
        <>
          <Welcome />
          {/* Collapsed until there are results to show */}
          <div className="flex h-8 flex-none items-center border-t border-border-soft bg-surface px-3.5 text-fg3">
            Results
          </div>
        </>
      ) : (
        <EditorAndResults />
      )}
    </main>
  );
}
