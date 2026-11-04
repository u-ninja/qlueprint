import { create } from "zustand";
import { commands, type CommandError, type ConnectRequest, type SavedConnection, type Schema } from "@/bindings";

/** An open connection: `id` is the Rust pool, `savedId` the saved entry it was opened from */
export type Connection = { id: number; savedId: string; label: string; schemas: Schema[] };

/** A saved connection that isn't open: still connecting, or failed with this message */
export type Closed = "connecting" | { error: string };

type ConnectionsState = {
  /** Every saved connection, open or not, in the order they were added */
  saved: SavedConnection[];
  connections: Connection[];
  /** Keyed by saved id; absent means open, or closed by the user */
  closed: Record<string, Closed>;
  connect: (request: ConnectRequest) => Promise<void>;
  open: (savedId: string) => Promise<void>;
  disconnect: (id: number) => Promise<void>;
  forget: (savedId: string) => Promise<void>;
};

function labelOf(request: ConnectRequest) {
  return request.kind === "postgres"
    ? `${request.database || request.user}@${request.host}`
    : (request.path.split(/[\\/]/).pop() ?? request.path);
}

export function errorMessage(error: unknown) {
  return (error as CommandError)?.message ?? String(error);
}

// Saved connections live in Rust (settings in a file, passwords in the OS credential store);
// this store mirrors them and the pools that are open
export const useConnections = create<ConnectionsState>()((set, get) => {
  const setClosed = (savedId: string, state: Closed | undefined) =>
    set((s) => {
      const { [savedId]: _, ...rest } = s.closed;
      return { closed: state ? { ...rest, [savedId]: state } : rest };
    });

  /** Loads the schema tree and shows the connection; closes the pool if that fails */
  async function show(id: number, saved: SavedConnection) {
    try {
      const schemas = await commands.listSchemas(id);
      setClosed(saved.id, undefined);
      set((s) => ({
        // Replace rather than add: after a UI reload Rust hands back the pool that was already open
        connections: [...s.connections.filter((c) => c.savedId !== saved.id), { id, savedId: saved.id, label: saved.label, schemas }],
      }));
    } catch (error) {
      // Don't leave an open pool the UI can't see
      await commands.disconnect(id);
      setClosed(saved.id, { error: errorMessage(error) });
      throw error;
    }
  }

  return {
    saved: [],
    connections: [],
    closed: {},

    connect: async (request) => {
      // Rust saves it only once the connection works, so a typo never ends up in the list
      const { saved, id } = await commands.connectAndSave(request, labelOf(request));
      set((s) => ({ saved: [...s.saved, saved] }));
      await show(id, saved);
    },

    open: async (savedId) => {
      const saved = get().saved.find((s) => s.id === savedId);
      if (!saved) return;
      setClosed(savedId, "connecting");
      let id: number;
      try {
        id = await commands.connectSaved(savedId);
      } catch (error) {
        setClosed(savedId, { error: errorMessage(error) });
        return;
      }
      await show(id, saved).catch(() => {});
    },

    disconnect: async (id) => {
      set((s) => ({ connections: s.connections.filter((c) => c.id !== id) }));
      await commands.disconnect(id);
    },

    forget: async (savedId) => {
      await commands.forgetSaved(savedId);
      setClosed(savedId, undefined);
      set((s) => ({
        saved: s.saved.filter((c) => c.id !== savedId),
        connections: s.connections.filter((c) => c.savedId !== savedId),
      }));
    },
  };
});

// Reconnect every saved connection at launch, in parallel; one that fails shows its error in
// the explorer instead of holding up the rest.
// shortcut: reconnects all of them, add the per-connection "reconnect automatically" setting (spec 5.2).
async function restore() {
  const saved = await commands.listSaved();
  useConnections.setState({ saved });
  await Promise.all(saved.map((s) => useConnections.getState().open(s.id)));
}
// Outside the Tauri app (a plain browser tab) there is no backend to restore from
restore().catch(() => {});
