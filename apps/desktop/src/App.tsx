import { useDefaultLayout } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Rail } from "@/components/shell/Rail";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { Workspace } from "@/components/shell/Workspace";
import { AuditLog } from "@/components/audit/AuditLog";
import { StatusDot } from "@/components/shell/StatusDot";
import { closedState, useConnections } from "@/stores/connections";
import { useUi } from "@/stores/ui";

// Opens straight into the workspace: no welcome screen, no sign-in wall, no loading screen
function App() {
  const { sidebarOpen, inspectorOpen, view } = useUi();
  const connections = useConnections((s) => s.connections);
  const failed = useConnections((s) => Object.values(s.closed).filter((c) => closedState(c) === "failed").length);
  const status =
    connections.length === 0 ? "No connection" : connections.length === 1 ? connections[0].label : `${connections.length} open`;
  const panelIds = [sidebarOpen && "sidebar", "main", inspectorOpen && "inspector"].filter((id) => id !== false);
  // Saves panel sizes to localStorage so they come back on the next launch
  const layout = useDefaultLayout({ id: "qc-workspace", panelIds, storage: localStorage });

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <Rail />
        <ResizablePanelGroup
          orientation="horizontal"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
        >
          {sidebarOpen && (
            <>
              <ResizablePanel id="sidebar" defaultSize={264} minSize={200} maxSize={480}>
                <Sidebar />
              </ResizablePanel>
              <ResizableHandle className="bg-border-soft" />
            </>
          )}
          <ResizablePanel id="main" minSize={360}>
            {/* The audit log needs the width for its columns and SQL; every other view keeps the editor here */}
            {view === "audit" ? <AuditLog /> : <Workspace />}
          </ResizablePanel>
          {inspectorOpen && (
            <>
              <ResizableHandle className="bg-border-soft" />
              <ResizablePanel id="inspector" defaultSize={300} minSize={240} maxSize={480}>
                <aside aria-label="Inspector" className="flex h-full flex-col bg-panel">
                  <h2 className="flex h-10 flex-none items-center px-3.5 font-semibold">Inspector</h2>
                  <p className="px-3.5 text-fg3">
                    Select a table in the explorer to see its columns, indexes and size.
                  </p>
                </aside>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
      <footer className="flex h-6 flex-none items-center gap-4 border-t border-border-soft bg-chrome px-3 text-[11.5px] text-fg3">
        <span className="flex items-center gap-1.5">
          <StatusDot state={connections.length ? "open" : "closed"} />
          {status}
        </span>
        {failed > 0 && (
          <span className="flex items-center gap-1.5">
            <StatusDot state="failed" />
            {failed} failed
          </span>
        )}
        <span className="ml-auto">Local</span>
      </footer>
    </div>
  );
}

export default App;
