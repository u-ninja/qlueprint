import { useState, type ReactNode } from "react";
import { ChevronRight, Database, Eye, FolderTree, Plug, Table2, Trash2, X, type LucideIcon } from "lucide-react";
import type { SavedConnection } from "@/bindings";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useConnections, type Closed } from "@/stores/connections";
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

const rowAction =
  "grid size-5 place-items-center rounded text-fg3 opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100";

/** A saved connection that isn't open: connecting, failed, or disconnected by the user */
function ClosedConnection({ saved, state }: { saved: SavedConnection; state: Closed | undefined }) {
  const open = useConnections((s) => s.open);
  const forget = useConnections((s) => s.forget);
  const connecting = state === "connecting";
  const error = typeof state === "object" ? state.error : undefined;

  return (
    <li>
      <div className={cn(row, "group")}>
        <span className="size-3.5 flex-none" aria-hidden />
        <Database className="size-3.5 flex-none text-fg4" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-fg3">{saved.label}</span>
        {connecting ? (
          <span role="status" className="text-xs text-fg4">
            Connecting…
          </span>
        ) : (
          <>
            <button onClick={() => void open(saved.id)} aria-label={`Connect ${saved.label}`} title="Connect" className={rowAction}>
              <Plug className="size-3.5" aria-hidden />
            </button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button aria-label={`Remove ${saved.label}`} title="Remove" className={rowAction}>
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove {saved.label}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    QueryCraft forgets this connection and deletes its saved password. The database itself isn’t touched.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => void forget(saved.id)}>
                    Remove connection
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </div>
      {error && (
        <p className="truncate pr-1 pl-10 text-xs text-danger" title={error}>
          {error}
        </p>
      )}
    </li>
  );
}

/** Saved connections; the open ones expand into their schema > table tree. */
export function Explorer() {
  const { saved, connections, closed, disconnect } = useConnections();

  return (
    <ul aria-label="Database explorer" className="px-1.5">
      {saved.map((entry) => {
        const c = connections.find((open) => open.savedId === entry.id);
        if (!c) return <ClosedConnection key={entry.id} saved={entry} state={closed[entry.id]} />;
        return (
        <Branch
          key={c.id}
          icon={Database}
          label={c.label}
          defaultOpen
          action={
            <button onClick={() => void disconnect(c.id)} aria-label={`Disconnect ${c.label}`} title="Disconnect" className={rowAction}>
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
        );
      })}
    </ul>
  );
}
