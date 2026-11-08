import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { commands, type QueryOutput } from "@/bindings";
import { count } from "@/lib/utils";
import { errorMessage, useConnections, type Connection } from "./connections";

export type Message = { at: Date; ok: boolean; text: string };

export type Outcome = { ok: true; output: QueryOutput } | { ok: false; error: string };

type QueryState = {
  sql: string;
  /** Run executes the editor selection instead of the whole script when there is one */
  hasSelection: boolean;
  /** Set by the editor on mount; reads the selection only when Run needs it */
  readSelection: () => string;
  /** Picked in the toolbar; null means "the most recently opened connection" */
  connectionId: string | null;
  /** MySQL database picked in the toolbar, per connection id; absent means the saved one */
  databases: Record<string, string>;
  /** When the current run started, null while idle */
  runningSince: number | null;
  /** Kept while a new run is in flight so the panel can show it as stale instead of blanking */
  last: Outcome | null;
  /** Newest last, capped at 500 */
  messages: Message[];
  setSql: (sql: string) => void;
  setHasSelection: (hasSelection: boolean) => void;
  setReadSelection: (read: () => string) => void;
  setConnectionId: (id: string) => void;
  setDatabase: (connectionId: string, database: string) => void;
  run: () => Promise<void>;
};

/** The toolbar's choice if it's still open, otherwise the newest connection */
export function activeConnection(connections: Connection[], id: string | null) {
  return connections.find((c) => c.id === id) ?? connections[connections.length - 1];
}

/** The toolbar's database pick, else the saved one. Rust only acts on it for MySQL */
export function activeDatabase(connection: Connection, databases: Record<string, string>) {
  return databases[connection.id] ?? connection.database;
}

/** "2 rows · 12 ms", "3 rows affected · 4 ms", with a note when the row cap cut it short */
export function summary({ columns, rowsAffected, rows, truncated, elapsedMs }: QueryOutput) {
  const what = `${count(rowsAffected, "row")}${columns.length ? "" : " affected"}`;
  const shown = truncated ? `, first ${rows.length.toLocaleString()} shown` : "";
  return `${what}${shown} · ${elapsedMs.toLocaleString()} ms`;
}

// persist writes after every set(), i.e. every keystroke; batch those into one write per pause
let pending: { name: string; value: string } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
function flush() {
  clearTimeout(timer);
  if (pending) localStorage.setItem(pending.name, pending.value);
  pending = undefined;
}
const debouncedLocalStorage = {
  getItem: (name: string) => localStorage.getItem(name),
  setItem: (name: string, value: string) => {
    pending = { name, value };
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  },
  removeItem: (name: string) => localStorage.removeItem(name),
};
// Don’t lose the last 400 ms of typing when the window closes
window.addEventListener("pagehide", flush);

export const useQuery = create<QueryState>()(
  persist(
    (set, get) => ({
      sql: "",
      hasSelection: false,
      readSelection: () => "",
      connectionId: null,
      databases: {},
      runningSince: null,
      last: null,
      messages: [],
      setSql: (sql) => set({ sql }),
      setHasSelection: (hasSelection) => set({ hasSelection }),
      setReadSelection: (readSelection) => set({ readSelection }),
      setConnectionId: (connectionId) => set({ connectionId }),
      setDatabase: (connectionId, database) => set((s) => ({ databases: { ...s.databases, [connectionId]: database } })),

      run: async () => {
        const { sql, readSelection, connectionId, databases, runningSince } = get();
        const connection = activeConnection(useConnections.getState().connections, connectionId);
        const text = readSelection().trim() || sql.trim();
        if (runningSince !== null || !connection || !text) return;

        set({ runningSince: Date.now() });
        let outcome: Outcome;
        try {
          outcome = { ok: true, output: await commands.runQuery(connection.id, text, activeDatabase(connection, databases)) };
        } catch (error) {
          outcome = { ok: false, error: errorMessage(error) };
        }
        const message = { at: new Date(), ok: outcome.ok, text: outcome.ok ? summary(outcome.output) : outcome.error };
        set((s) => ({ runningSince: null, last: outcome, messages: [...s.messages.slice(-499), message] }));
      },
    }),
    // Only the draft survives a restart; results and connections end with the app
    { name: "qc-query", partialize: ({ sql }) => ({ sql }), storage: createJSONStorage(() => debouncedLocalStorage) },
  ),
);
