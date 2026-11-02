import { useState, type ReactNode } from "react";
import { ChevronRight, Database, Eye, FolderTree, Table2, X, type LucideIcon } from "lucide-react";
import { useConnections } from "@/stores/connections";
import { cn } from "@/lib/utils";

const row = "flex h-7 items-center gap-1.5 rounded-md px-1 hover:bg-hover";

function Branch(props: { icon: LucideIcon; label: string; defaultOpen: boolean; action?: ReactNode; children: ReactNode }) {
  const { icon: Icon, label, defaultOpen, action, children } = props;
  const [open, setOpen] = useState(defaultOpen);
  return (
    <li>
      <div className={cn(row, "group")}>
        <button aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-1.5">
          <ChevronRight className={cn("size-3.5 flex-none text-fg3", open && "rotate-90")} aria-hidden />
          <Icon className="size-3.5 flex-none text-fg3" aria-hidden />
          <span className="truncate">{label}</span>
        </button>
        {action}
      </div>
      {/* Children mount only while open, so a closed schema with thousands of tables costs nothing */}
      {open && <ul className="pl-4">{children}</ul>}
    </li>
  );
}

/** Connection > schema > table tree for the open connections. */
export function Explorer() {
  const { connections, disconnect } = useConnections();

  return (
    <ul aria-label="Database explorer" className="px-1.5">
      {connections.map((c) => (
        <Branch
          key={c.id}
          icon={Database}
          label={c.label}
          defaultOpen
          action={
            <button
              onClick={() => disconnect(c.id)}
              aria-label={`Disconnect ${c.label}`}
              title="Disconnect"
              className="grid size-5 place-items-center rounded text-fg3 opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          }
        >
          {c.schemas.map((s) => (
            // Open the default schema; the rest stay closed until asked for
            <Branch key={s.name} icon={FolderTree} label={s.name} defaultOpen={s.name === "public" || s.name === "main"}>
              {s.tables.length === 0 && <li className="h-7 px-6 leading-7 text-fg3">No tables</li>}
              {/* shortcut: renders every table of an open schema, virtualize (TanStack Virtual) if 10k+ table schemas lag */}
              {s.tables.map((t) => {
                const Icon = t.view ? Eye : Table2;
                return (
                  <li key={t.name} className={cn(row, "pl-6")} title={t.view ? `${t.name} (view)` : t.name}>
                    <Icon className="size-3.5 flex-none text-fg3" aria-label={t.view ? "View" : "Table"} />
                    <span className="truncate">{t.name}</span>
                  </li>
                );
              })}
            </Branch>
          ))}
        </Branch>
      ))}
    </ul>
  );
}
