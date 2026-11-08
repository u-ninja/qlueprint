import { useEffect, useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { Download, RotateCw, Search, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import type { EventKind, ExportFormat } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnections } from "@/stores/connections";
import { eventLabel, useAudit } from "@/stores/audit";
import { count } from "@/lib/utils";
import { AuditDetails } from "./AuditDetails";
import { AuditList } from "./AuditList";

// Radix Select has no empty value, so "all" stands for no filter
const ALL = "all";
const SEARCH_DELAY_MS = 250;

const entries = (n: number) => count(n, "entry", "entries");

function SearchFilter() {
  const setFilters = useAudit((s) => s.setFilters);
  const [text, setText] = useState(() => useAudit.getState().filters.search);
  // Filters once typing pauses, not on every keystroke
  useEffect(() => {
    if (text === useAudit.getState().filters.search) return;
    const timer = setTimeout(() => setFilters({ search: text }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, setFilters]);

  return (
    <div className="relative w-52 min-w-28">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg4" aria-hidden />
      <Input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search"
        aria-label="Search the audit log"
        spellCheck={false}
        name="audit-search"
        autoComplete="off"
        className="h-7 pl-8 text-[13px]"
      />
    </div>
  );
}

function EventFilter() {
  const event = useAudit((s) => s.filters.event);
  const setFilters = useAudit((s) => s.setFilters);
  return (
    <Select value={event ?? ALL} onValueChange={(v) => setFilters({ event: v === ALL ? null : (v as EventKind) })}>
      <SelectTrigger size="sm" aria-label="Event type" className="w-40 min-w-24">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectItem value={ALL}>All events</SelectItem>
        {Object.entries(eventLabel).map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ConnectionFilter() {
  const saved = useConnections((s) => s.saved);
  const connectionId = useAudit((s) => s.filters.connectionId);
  const setFilters = useAudit((s) => s.setFilters);
  return (
    <Select value={connectionId ?? ALL} onValueChange={(v) => setFilters({ connectionId: v === ALL ? null : v })}>
      <SelectTrigger size="sm" aria-label="Connection" className="w-44 min-w-24">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" className="max-w-80">
        <SelectItem value={ALL}>All connections</SelectItem>
        {saved.map((c) => (
          <SelectItem key={c.id} value={c.id} title={c.label}>
            <span className="truncate">{c.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** "Chain intact · 1,204 entries", or the first entry that doesn't match */
function IntegrityStatus() {
  const integrity = useAudit((s) => s.integrity);
  const select = useAudit((s) => s.select);
  if (integrity === null) return null;
  if (integrity === "checking") return <span className="text-fg3">Checking…</span>;
  if ("error" in integrity)
    return (
      <span className="truncate text-danger" title={integrity.error}>
        Couldn’t check the chain
      </span>
    );
  if (integrity.intact)
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-fg2">
        <ShieldCheck className="size-3.5 flex-none text-success" aria-hidden />
        <span className="truncate">
          Chain intact · <span className="font-mono text-xs tabular-nums">{entries(integrity.entries)}</span>
        </span>
      </span>
    );
  const brokenId = integrity.brokenId;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-danger">
      <ShieldAlert className="size-3.5 flex-none" aria-hidden />
      <button type="button" className="truncate underline-offset-2 hover:underline" onClick={() => brokenId !== null && select(brokenId)}>
        Chain broken at entry <span className="font-mono text-xs tabular-nums">#{brokenId}</span>
      </button>
    </span>
  );
}

function ExportButton({ format }: { format: ExportFormat }) {
  const exportLog = useAudit((s) => s.exportLog);
  const label = format.toUpperCase();
  return (
    <Button variant="ghost" size="sm" aria-label={`Export ${label}`} title={`Export the whole log as ${label}`} onClick={() => void exportLog(format)}>
      <Download aria-hidden className="hidden @3xl:block" /> {label}
    </Button>
  );
}

function Toolbar() {
  const verify = useAudit((s) => s.verify);
  const load = useAudit((s) => s.load);
  const checking = useAudit((s) => s.integrity === "checking");
  return (
    // A container: when narrow, the actions drop their labels so the filters keep their room
    <div className="@container flex h-11 flex-none items-center gap-1.5 border-b border-border-soft px-2.5">
      <SearchFilter />
      <EventFilter />
      <ConnectionFilter />
      <Button variant="ghost" size="icon-sm" onClick={() => void load()} aria-label="Refresh" title="Refresh" className="text-fg3">
        <RotateCw className="size-3.5" aria-hidden />
      </Button>
      <Button variant="ghost" size="sm" onClick={() => void verify()} className="ml-auto" disabled={checking} aria-label="Check integrity" title="Recompute every entry’s hash">
        <ShieldCheck aria-hidden /> <span className="hidden @4xl:inline">Check integrity</span>
      </Button>
      <ExportButton format="csv" />
      <ExportButton format="json" />
    </div>
  );
}

/** Under the toolbar: how many entries are loaded, and the last integrity check */
function StatusStrip() {
  const loaded = useAudit((s) => s.events.length);
  const hasMore = useAudit((s) => s.nextCursor !== null);
  const exportError = useAudit((s) => s.exportError);
  return (
    <div className="flex h-8 flex-none items-center gap-3 border-b border-border-soft px-3.5 text-xs text-fg3">
      <span>
        <span className="font-mono tabular-nums">{entries(loaded)}</span>
        {hasMore ? ", more as you scroll" : ""}
      </span>
      {exportError && (
        <span role="alert" className="min-w-0 truncate text-danger" title={exportError}>
          {exportError}
        </span>
      )}
      <div role="status" className="ml-auto flex min-w-0 items-center">
        <IntegrityStatus />
      </div>
    </div>
  );
}

function FailedWrites() {
  const failedWrites = useAudit((s) => s.failedWrites);
  if (failedWrites === 0) return null;
  return (
    <p role="status" className="flex flex-none items-center gap-2 border-b border-border-soft bg-warning-soft px-3.5 py-1.5 text-fg2">
      <TriangleAlert className="size-3.5 flex-none text-warning" aria-hidden />
      {entries(failedWrites)} couldn’t be written since launch. Their actions still ran
    </p>
  );
}

function Entries() {
  const empty = useAudit((s) => s.events.length === 0);
  const loading = useAudit((s) => s.loading);
  const error = useAudit((s) => s.error);
  const filtered = useAudit((s) => s.filters.event !== null || s.filters.connectionId !== null || s.filters.search.trim() !== "");

  if (error)
    return (
      <div role="alert" className="grid h-full place-items-center px-6 text-center text-danger">
        {error}
      </div>
    );
  if (empty)
    return (
      <div className="grid h-full place-items-center px-6 text-center text-fg3">
        {loading ? "Loading…" : filtered ? "No entries match these filters" : "Nothing recorded yet. Connections and queries show up here as they happen."}
      </div>
    );
  return <AuditList />;
}

/** The audit log screen: filters, the entries newest first, and the selected entry's details */
export function AuditLog() {
  const load = useAudit((s) => s.load);
  // Saves the list/details split so it comes back on the next launch
  const layout = useDefaultLayout({ id: "qc-audit", panelIds: ["entries", "details"], storage: localStorage });

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main aria-label="Audit log" className="flex h-full min-w-0 flex-col overflow-hidden bg-editor">
      <Toolbar />
      <FailedWrites />
      <StatusStrip />
      <ResizablePanelGroup
        orientation="vertical"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        className="min-h-0 flex-1"
      >
        <ResizablePanel id="entries" minSize={120}>
          <Entries />
        </ResizablePanel>
        <ResizableHandle className="bg-border-soft" />
        <ResizablePanel id="details" defaultSize="40%" minSize={80} className="bg-surface">
          <AuditDetails />
        </ResizablePanel>
      </ResizablePanelGroup>
    </main>
  );
}
