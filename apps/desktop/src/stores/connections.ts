import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

// These types mirror src-tauri/src/db.rs; keep them in sync.
export type Table = { name: string; view: boolean };
export type Schema = { name: string; tables: Table[] };
export type ConnectRequest =
  | { kind: "postgres"; host: string; port: number; user: string; password: string; database: string }
  | { kind: "sqlite"; path: string };
/** What every failed command rejects with. */
export type CommandError = { code: string; message: string };

export type Connection = { id: number; label: string; schemas: Schema[] };

type ConnectionsState = {
  connections: Connection[];
  connect: (request: ConnectRequest) => Promise<void>;
  disconnect: (id: number) => Promise<void>;
};

function labelOf(request: ConnectRequest) {
  return request.kind === "postgres"
    ? `${request.database || request.user}@${request.host}`
    : (request.path.split(/[\\/]/).pop() ?? request.path);
}

export function errorMessage(error: unknown) {
  return (error as CommandError)?.message ?? String(error);
}

// Not persisted: open connections end with the app. Saved connections come with the keychain work.
export const useConnections = create<ConnectionsState>()((set) => ({
  connections: [],

  connect: async (request) => {
    const id = await invoke<number>("connect", { request });
    try {
      const schemas = await invoke<Schema[]>("list_schemas", { id });
      set((s) => ({ connections: [...s.connections, { id, label: labelOf(request), schemas }] }));
    } catch (error) {
      // Don't leave an open pool the UI can't see
      await invoke("disconnect", { id });
      throw error;
    }
  },

  disconnect: async (id) => {
    set((s) => ({ connections: s.connections.filter((c) => c.id !== id) }));
    await invoke("disconnect", { id });
  },
}));
