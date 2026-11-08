import { AlignLeft, ListTree, PanelRight, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PendingAction } from "@/components/shell/PendingAction";
import { useConnections } from "@/stores/connections";
import { activeConnection, activeDatabase, useQuery } from "@/stores/query";
import { useUi } from "@/stores/ui";
import { engineName } from "@/lib/engines";
import { cn, runShortcut } from "@/lib/utils";

// Fixed trigger widths so switching to a long label never shifts the toolbar; the menu may grow
// past its trigger up to a cap, and long labels truncate (full text in `title`)
const menu = "max-w-80 min-w-(--radix-select-trigger-width)";

function ConnectionPicker() {
  const connections = useConnections((s) => s.connections);
  const connectionId = useQuery((s) => s.connectionId);
  const setConnectionId = useQuery((s) => s.setConnectionId);
  const active = activeConnection(connections, connectionId);

  return (
    <Select value={active?.id ?? ""} onValueChange={setConnectionId} disabled={!active}>
      <SelectTrigger size="sm" aria-label="Connection to run on" title={active?.label} className="w-56">
        <span className={cn("size-1.5 flex-none rounded-full", active ? "bg-success" : "bg-fg4")} aria-hidden />
        {/* Just the label: the default would copy the item's two-line content */}
        <SelectValue placeholder="No connection">{active?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="end" className={menu}>
        <SelectGroup>
          <SelectLabel>Run on</SelectLabel>
          {connections.map((c) => (
            <SelectItem key={c.id} value={c.id} title={c.label} className="py-1.5">
              <span className="flex min-w-0 flex-col gap-px">
                <span className="truncate">{c.label}</span>
                <span className="text-[11px] text-fg3">{engineName[c.kind]}</span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/**
 * Only MySQL can switch: Postgres can't on an open connection, and SQLite has one. Other kinds show
 * their database disabled, so the toolbar keeps its layout when switching connections
 */
function DatabasePicker() {
  const connections = useConnections((s) => s.connections);
  const connectionId = useQuery((s) => s.connectionId);
  const databases = useQuery((s) => s.databases);
  const setDatabase = useQuery((s) => s.setDatabase);
  const active = activeConnection(connections, connectionId);
  if (!active) return null;
  const switchable = active.kind === "mysql";
  const database = activeDatabase(active, databases) || undefined;

  return (
    <Select value={database ?? ""} onValueChange={(name) => setDatabase(active.id, name)} disabled={!switchable}>
      <SelectTrigger
        size="sm"
        aria-label="Database to run in"
        title={switchable ? database : `${engineName[active.kind]} can’t switch database on an open connection`}
        className="w-40"
      >
        <SelectValue placeholder={switchable ? "No database" : "Default database"} />
      </SelectTrigger>
      <SelectContent position="popper" align="end" className={menu}>
        <SelectGroup>
          <SelectLabel>Database</SelectLabel>
          {switchable && active.schemas.map(({ name }) => (
            <SelectItem key={name} value={name} title={name}>
              <span className="truncate">{name}</span>
            </SelectItem>
          ))}
        </SelectGroup>
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
        <DatabasePicker />
        <InspectorToggle />
      </div>
    </div>
  );
}
