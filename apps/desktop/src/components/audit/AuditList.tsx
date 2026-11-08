import { useEffect, useRef, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { StatusDot } from "@/components/shell/StatusDot";
import { eventLabel, failed, useAudit, type AuditEvent } from "@/stores/audit";
import { cn } from "@/lib/utils";

const ROW_HEIGHT = 28;
// Start the next page this many rows before the end, so scrolling rarely waits on it
const PREFETCH = 40;

const pad = (n: number) => String(n).padStart(2, "0");

/** Local time as `2026-11-08 14:03:22`: fixed width, so the column lines up in mono */
export function localTime(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The one-line summary: the SQL for a query, else the error or where the connection points */
function summaryOf({ details }: AuditEvent) {
  return details.sql ?? details.error ?? details.target ?? "";
}

const rowId = (id: number) => `audit-entry-${id}`;

function Row({ event, selected }: { event: AuditEvent; selected: boolean }) {
  const select = useAudit((s) => s.select);
  const summary = summaryOf(event);
  return (
    <div
      id={rowId(event.id)}
      role="option"
      aria-selected={selected}
      onClick={() => select(event.id)}
      className={cn(
        "flex h-full cursor-default items-center gap-3 border-b border-border-soft px-3.5 hover:bg-hover",
        selected && "bg-sel hover:bg-sel",
      )}
    >
      <time
        dateTime={new Date(event.at).toISOString()}
        title={new Date(event.at).toISOString()}
        className="w-36 flex-none font-mono text-xs whitespace-nowrap text-fg3 tabular-nums"
      >
        {localTime(event.at)}
      </time>
      <span className="flex w-36 flex-none items-center gap-2">
        <StatusDot state={failed(event) ? "failed" : "open"} />
        <span className="truncate">{eventLabel[event.event]}</span>
      </span>
      <span className="w-36 flex-none truncate text-fg2" title={event.details.label}>
        {event.details.label}
      </span>
      <span
        className={cn("min-w-0 flex-1 truncate font-mono text-xs", event.details.sql ? "text-fg2" : "text-fg3")}
        title={summary.length > 60 ? summary : undefined}
      >
        {summary}
      </span>
    </div>
  );
}

/** Virtualized and keyboard navigable: arrows, Home and End move the selection */
export function AuditList() {
  const events = useAudit((s) => s.events);
  const selectedId = useAudit((s) => s.selectedId);
  const hasMore = useAudit((s) => s.nextCursor !== null);
  const loadMore = useAudit((s) => s.loadMore);
  const select = useAudit((s) => s.select);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length ? items[items.length - 1].index : -1;

  useEffect(() => {
    if (hasMore && lastIndex >= events.length - PREFETCH) void loadMore();
  }, [hasMore, lastIndex, events.length, loadMore]);

  const selectedIndex = events.findIndex((e) => e.id === selectedId);

  function handleKeyDown(e: KeyboardEvent) {
    const last = events.length - 1;
    const next = { ArrowDown: Math.min(selectedIndex + 1, last), ArrowUp: Math.max(selectedIndex - 1, 0), Home: 0, End: last }[e.key];
    if (next === undefined || last < 0) return;
    e.preventDefault();
    select(events[next].id);
    virtualizer.scrollToIndex(next);
  }

  return (
    <div
      ref={scrollRef}
      role="listbox"
      aria-label="Audit entries"
      tabIndex={0}
      aria-activedescendant={selectedIndex >= 0 ? rowId(events[selectedIndex].id) : undefined}
      onKeyDown={handleKeyDown}
      className="h-full overflow-auto text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
    >
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const event = events[item.index];
          return (
            <div
              key={event.id}
              className="absolute left-0 w-full"
              style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
            >
              <Row event={event} selected={event.id === selectedId} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
