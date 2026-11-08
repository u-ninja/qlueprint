import { useEffect, useMemo, useRef, useState } from "react";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ColumnKind, QueryOutput, ResultColumn } from "@/bindings";
import { cn } from "@/lib/utils";

type Row = (string | null)[];

const ROW_HEIGHT = 28;
const GUTTER = 52;

// Rust decides each column's kind from the driver's type info, for every engine
const kindWidths: Record<ColumnKind, number> = {
  number: 100,
  bool: 84,
  temporal: 190,
  uuid: 300,
  json: 280,
  binary: 200,
  text: 180,
};

/** Fits the type's usual values and the header (name + type label), within reason */
function widthOf({ name, typeName, kind }: ResultColumn) {
  const byType = kindWidths[kind];
  const header = name.length * 7.5 + typeName.length * 6.5 + 36;
  return Math.round(Math.min(Math.max(byType, header), 420));
}

/** Virtualized, resizable grid for one result set */
export function ResultsGrid({ output }: { output: QueryOutput }) {
  const columns = useMemo<ColumnDef<Row>[]>(
    () =>
      output.columns.map((column, i) => ({
        // Index, not name: a result can have two columns with the same name
        id: String(i),
        header: column.name,
        accessorFn: (row) => row[i],
        size: widthOf(column),
      })),
    [output.columns],
  );
  const table = useReactTable({
    data: output.rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: "onChange",
    defaultColumn: { minSize: 56, maxSize: 1200 },
  });
  const rows = table.getRowModel().rows;

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // A new result starts at the top-left, not wherever the previous one was scrolled to
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [output]);

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = (value: string | null) =>
    void navigator.clipboard.writeText(value ?? "").then(() => setCopied(true), () => {});

  const width = GUTTER + table.getTotalSize();
  const gutter = "sticky left-0 z-10 flex w-13 flex-none items-center justify-end border-r border-border-soft pr-2.5";

  return (
    <div className="relative h-full">
      <div ref={scrollRef} className="h-full overflow-auto text-[12.5px] select-text">
        <div
          role="table"
          aria-label="Query results"
          aria-rowcount={rows.length + 1}
          aria-colcount={columns.length}
          style={{ width, minWidth: "100%" }}
        >
          <div role="row" aria-rowindex={1} className="sticky top-0 z-20 flex h-7.5 border-b border-border-soft bg-header">
            <div role="columnheader" aria-label="Row number" className={cn(gutter, "z-30 bg-header")} />
            {table.getHeaderGroups()[0].headers.map((header) => {
              const numeric = output.columns[header.index].kind === "number";
              return (
                <div
                  key={header.id}
                  role="columnheader"
                  style={{ width: header.getSize() }}
                  className={cn(
                    "relative flex flex-none items-center gap-1.5 border-r border-border-soft px-2.5",
                    numeric && "justify-end",
                  )}
                >
                  <span className="truncate font-medium">{flexRender(header.column.columnDef.header, header.getContext())}</span>
                  <span className="flex-none font-mono text-[10.5px] text-fg4">{output.columns[header.index].typeName.toLowerCase()}</span>
                  {/* Drag to resize, double-click to reset */}
                  <div
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    onDoubleClick={() => header.column.resetSize()}
                    aria-hidden
                    className={cn(
                      "absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none select-none hover:bg-primary/40",
                      header.column.getIsResizing() && "bg-primary/60",
                    )}
                  />
                </div>
              );
            })}
          </div>

          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={item.index + 2}
                  className="group absolute left-0 flex w-full border-b border-border-soft hover:bg-hover"
                  style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
                >
                  <div role="rowheader" className={cn(gutter, "bg-surface font-mono text-[11px] text-fg4 tabular-nums")}>
                    {item.index + 1}
                  </div>
                  {row.getVisibleCells().map((cell) => {
                    const value = cell.getValue<string | null>();
                    const { kind } = output.columns[cell.column.getIndex()];
                    const numeric = kind === "number";
                    // Values compared character by character (figures, times, ids, JSON, bytes) are set in mono
                    const mono = kind !== "text";
                    return (
                      <div
                        key={cell.id}
                        role="cell"
                        // Double-click copies, so it shouldn't also select a word; drag-selecting still works
                        onMouseDown={(e) => e.detail > 1 && e.preventDefault()}
                        onDoubleClick={() => copy(value)}
                        title={value === null ? "NULL · double-click to copy" : value.length > 40 ? value : "Double-click to copy"}
                        style={{ width: cell.column.getSize() }}
                        className={cn(
                          "flex flex-none items-center overflow-hidden px-2.5 whitespace-nowrap",
                          numeric && "justify-end tabular-nums",
                          mono && "font-mono text-xs",
                          // NULL reads as a marker, not a value: small mono, muted, never italic
                          value === null && "font-mono text-[11px] text-fg4",
                        )}
                      >
                        <span className="truncate">{value ?? "NULL"}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <span
        role="status"
        className={cn(
          "pointer-events-none absolute right-3 bottom-3 rounded-md bg-elev px-2.5 py-1 text-xs text-fg2 ring-1 ring-border transition-opacity",
          copied ? "opacity-100" : "opacity-0",
        )}
      >
        {copied ? "Copied" : ""}
      </span>
    </div>
  );
}
