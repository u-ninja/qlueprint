import { AlignLeft, ListTree, PanelRight, Play, Square, type LucideIcon } from "lucide-react";
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
import { StatusDot } from "@/components/shell/StatusDot";
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
      <SelectTrigger size="sm" aria-label="Connection to run on" title={active?.label} className="w-56 min-w-28">
        <StatusDot state={active ? "open" : "closed"} />
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
 * MySQL switches with USE; Postgres switches only with "Show all databases" on (each database gets
 * its own pool); SQLite has one. A picker that can't switch shows its database disabled, so the
 * toolbar keeps its layout when switching connections
 */
function DatabasePicker() {
  const connections = useConnections((s) => s.connections);
  const connectionId = useQuery((s) => s.connectionId);
  const databases = useQuery((s) => s.databases);
  const setDatabase = useQuery((s) => s.setDatabase);
  const active = activeConnection(connections, connectionId);
  if (!active) return null;
  const { switchable } = active;
  const database = activeDatabase(active, databases) || undefined;

  return (
    <Select value={database ?? ""} onValueChange={(name) => setDatabase(active.id, name)} disabled={!switchable}>
      <SelectTrigger
        size="sm"
        aria-label="Database to run in"
        title={switchable ? database : active.kind === "postgres" ? "Turn on “Show all databases” for this connection to switch" : `${engineName[active.kind]} has one database`}
        className="w-40 min-w-24"
      >
        {/* Explicit: Radix only shows a value that matches an item, and a disabled picker has none */}
        <SelectValue placeholder={switchable ? "No database" : "Default database"}>{database}</SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="end" className={menu}>
        <SelectGroup>
          <SelectLabel>Database</SelectLabel>
          {switchable && active.databases.map((name) => (
            <SelectItem key={name} value={name} title={name}>
              <span className="truncate">{name}</span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

// shortcut: Stop/Explain/Format aren't built yet; give ToolbarAction an onClick when they land
const pendingActions: { label: string; icon: LucideIcon }[] = [
  { label: "Stop", icon: Square },
  { label: "Explain", icon: ListTree },
  { label: "Format", icon: AlignLeft },
];

/** A secondary toolbar action: icon only when the toolbar is narrow, the label stays as its name */
function ToolbarAction({ label, icon: Icon }: { label: string; icon: LucideIcon }) {
  return (
    <PendingAction variant="ghost" size="sm" aria-label={label}>
      <Icon aria-hidden /> <span className="hidden @3xl:inline">{label}</span>
    </PendingAction>
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
    // A container: on a narrow window the secondary actions drop their labels and the pickers
    // shrink, so the toolbar never pushes the editor wider than its panel
    <div className="@container flex h-11 flex-none items-center gap-1 border-b border-border-soft px-2.5">
      <Button size="sm" onClick={() => void run()} disabled={running || !hasSql || !connected} title={runShortcut}>
        <Play aria-hidden /> {hasSelection ? "Run selection" : "Run"}
      </Button>
      {pendingActions.map((action) => (
        <ToolbarAction key={action.label} {...action} />
      ))}
      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <ConnectionPicker />
        <DatabasePicker />
        <InspectorToggle />
      </div>
    </div>
  );
}
