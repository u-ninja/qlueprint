import { create } from "zustand";
import { commands, type CommandError, type ConnectRequest, type Schema } from "@/bindings";

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
    const id = await commands.connect(request);
    try {
      const schemas = await commands.listSchemas(id);
      set((s) => ({ connections: [...s.connections, { id, label: labelOf(request), schemas }] }));
    } catch (error) {
      // Don't leave an open pool the UI can't see
      await commands.disconnect(id);
      throw error;
    }
  },

  disconnect: async (id) => {
    set((s) => ({ connections: s.connections.filter((c) => c.id !== id) }));
    await commands.disconnect(id);
  },
}));
