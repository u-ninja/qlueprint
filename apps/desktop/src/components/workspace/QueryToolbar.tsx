import { AlignLeft, ListTree, PanelRight, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PendingAction } from "@/components/shell/PendingAction";
import { useConnections } from "@/stores/connections";
import { activeConnection, useQuery } from "@/stores/query";
import { useUi } from "@/stores/ui";
import { cn, runShortcut } from "@/lib/utils";

function ConnectionPicker() {
  const connections = useConnections((s) => s.connections);
  const connectionId = useQuery((s) => s.connectionId);
  const setConnectionId = useQuery((s) => s.setConnectionId);
  const active = activeConnection(connections, connectionId);

  return (
    <Select
      value={active ? String(active.id) : ""}
      onValueChange={(id) => setConnectionId(Number(id))}
      disabled={!active}
    >
      <SelectTrigger size="sm" aria-label="Connection to run on" className="min-w-40">
        <span className={cn("size-1.5 flex-none rounded-full", active ? "bg-success" : "bg-fg4")} aria-hidden />
        <SelectValue placeholder="Select a database" />
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        {connections.map((c) => (
          <SelectItem key={c.id} value={String(c.id)}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function InspectorToggle() {
  const { inspectorOpen, toggleInspector } = useUi();
  const label = inspectorOpen ? "Hide inspector" : "Show inspector";
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={toggleInspector}
      aria-label={label}
      aria-pressed={inspectorOpen}
      title={label}
      className={cn("text-fg3", inspectorOpen && "text-primary-text")}
    >
      <PanelRight className="size-4" aria-hidden />
    </Button>
  );
}

export function QueryToolbar() {
  const running = useQuery((s) => s.runningSince !== null);
  const hasSelection = useQuery((s) => s.hasSelection);
  const hasSql = useQuery((s) => /\S/.test(s.sql));
  const connected = useConnections((s) => s.connections.length > 0);
  const run = useQuery((s) => s.run);

  return (
    <div className="flex h-11 flex-none items-center gap-1 border-b border-border-soft px-2.5">
      <Button size="sm" onClick={() => void run()} disabled={running || !hasSql || !connected} title={runShortcut}>
        <Play aria-hidden /> {hasSelection ? "Run selection" : "Run"}
      </Button>
      <PendingAction variant="ghost" size="sm">
        <Square aria-hidden /> Stop
      </PendingAction>
      <PendingAction variant="ghost" size="sm">
        <ListTree aria-hidden /> Explain
      </PendingAction>
      <PendingAction variant="ghost" size="sm">
        <AlignLeft aria-hidden /> Format
      </PendingAction>
      <div className="ml-auto flex items-center gap-1.5">
        <ConnectionPicker />
        <InspectorToggle />
      </div>
    </div>
  );
}
