import { Plus, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConnections } from "@/stores/connections";
import { useUi, type View } from "@/stores/ui";
import { ConnectDialog } from "./ConnectDialog";
import { Explorer } from "./Explorer";
import { PendingAction } from "./PendingAction";
import { views } from "./Rail";

const emptyText: Record<View, string> = {
  workspace: "No connections yet. Connect to a database or create a local one to see it here.",
  connections: "No saved connections.",
  queries: "No saved queries.",
  history: "No queries run yet.",
};

export function Sidebar() {
  const view = useUi((s) => s.view);
  const title = views.find((v) => v.value === view)?.label;
  const hasSaved = useConnections((s) => s.saved.length > 0);
  // Both views list the saved connections; the others have nothing to list yet
  const listsConnections = view === "workspace" || view === "connections";
  const showExplorer = listsConnections && hasSaved;

  return (
    <aside aria-label={title} className="flex h-full flex-col bg-panel">
      <h2 className="flex h-10 flex-none items-center px-3.5 font-semibold">{title}</h2>
      {showExplorer && <Explorer />}
      <div className="flex flex-col gap-3 px-3.5 py-2">
        {!showExplorer && <p className="text-fg3">{emptyText[view]}</p>}
        {listsConnections && (
          <div className="flex flex-col items-start gap-1.5">
            <ConnectDialog>
              <Button variant="outline" size="sm">
                <Plus aria-hidden /> New connection
              </Button>
            </ConnectDialog>
            {view === "workspace" && (
              <PendingAction variant="outline" size="sm">
                <Server aria-hidden /> Create local server
              </PendingAction>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
