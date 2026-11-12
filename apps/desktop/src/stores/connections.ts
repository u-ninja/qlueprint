import { create } from 'zustand';
import { commands, type CommandError, type ConnectRequest, type SavedConfig, type SavedConnection, type Schema } from '@/bindings';
import { forgetColumns } from '@/lib/columns';
import { forgetDetails } from '@/lib/table-details';
import { useUi } from './ui';

/**
 * An open connection: `id` is the Rust pool, which is keyed by `savedId`, the saved entry it was opened from.
 * `database`, `databases` and `switchable` are Rust's `ConnectionDatabases`: what the explorer and the
 * toolbar's picker show. `others` caches the schemas of other Postgres databases once loaded.
 */
export type Connection = {
    id: string;
    savedId: string;
    label: string;
    kind: SavedConfig['kind'];
    database: string;
    databases: string[];
    switchable: boolean;
    schemas: Schema[];
    others: Record<string, Schema[]>;
};

/** A saved connection that isn't open: still connecting, or failed with this message */
export type Closed = 'connecting' | { error: string };

export type ConnectionState = 'open' | 'connecting' | 'failed' | 'closed';

/** The state of a saved connection that isn't open (no entry: closed by the user) */
export function closedState(state: Closed | undefined): ConnectionState {
    if (state === 'connecting') return 'connecting';
    return state ? 'failed' : 'closed';
}

type ConnectionsState = {
    /** Every saved connection, open or not, in the order they were added */
    saved: SavedConnection[];
    connections: Connection[];
    /** Keyed by saved id; absent means open, or closed by the user */
    closed: Record<string, Closed>;
    /** Connects and saves under `label` (Rust trims it and refuses a blank one) */
    connect: (request: ConnectRequest, label: string) => Promise<void>;
    /** Lists and shows a connection Rust already saved and opened (local databases) */
    add: (saved: SavedConnection) => Promise<void>;
    /** Drops a connection Rust already forgot (a local database whose data was deleted) */
    discard: (savedId: string) => void;
    open: (savedId: string) => Promise<void>;
    disconnect: (id: string) => Promise<void>;
    forget: (savedId: string) => Promise<void>;
    /** Loads another Postgres database's schemas into `others` (its pool opens on first use) */
    loadOtherDatabase: (id: string, database: string) => Promise<void>;
    /** Re-lists one other Postgres database's schemas, or (no database, or its own) the whole connection */
    refresh: (id: string, database?: string) => Promise<void>;
    rename: (savedId: string, label: string) => Promise<void>;
    /** Saves new settings and name for a saved connection (empty password: keep the saved one) and reopens it */
    update: (savedId: string, request: ConnectRequest, label: string) => Promise<void>;
};

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
    async function show(saved: SavedConnection) {
        const { config } = saved;
        try {
            const [schemas, { current, listed, switchable }] = await Promise.all([
                commands.listSchemas(saved.id, null),
                commands.connectionDatabases(saved.id),
            ]);
            setClosed(saved.id, undefined);
            set((s) => ({
                // Replace rather than add: after a UI reload Rust hands back the pool that was already open
                connections: [
                    ...s.connections.filter((c) => c.savedId !== saved.id),
                    {
                        id: saved.id,
                        savedId: saved.id,
                        label: saved.label,
                        kind: config.kind,
                        database: current,
                        databases: listed,
                        switchable,
                        schemas,
                        others: {},
                    },
                ],
            }));
        } catch (error) {
            // Don't leave an open pool the UI can't see
            await commands.disconnect(saved.id);
            setClosed(saved.id, { error: errorMessage(error) });
            throw error;
        }
    }

    return {
        saved: [],
        connections: [],
        closed: {},

        connect: async (request, label) => {
            // Rust saves it only once the connection works, so a typo never ends up in the list
            await get().add(await commands.connectAndSave(request, label));
        },

        add: async (saved) => {
            // A new one goes into the workspace on show
            const ui = useUi.getState();
            if (!get().saved.some((c) => c.id === saved.id)) ui.moveConnection(saved.id, ui.workspace);
            // An edited connection keeps its place in the list
            set((s) => ({
                saved: s.saved.some((c) => c.id === saved.id) ? s.saved.map((c) => (c.id === saved.id ? saved : c)) : [...s.saved, saved],
            }));
            await show(saved);
        },

        discard: (savedId) => {
            setClosed(savedId, undefined);
            set((s) => ({
                saved: s.saved.filter((c) => c.id !== savedId),
                connections: s.connections.filter((c) => c.savedId !== savedId),
            }));
        },

        open: async (savedId) => {
            const saved = get().saved.find((s) => s.id === savedId);
            if (!saved) return;
            setClosed(savedId, 'connecting');
            try {
                await commands.connectSaved(savedId);
            } catch (error) {
                setClosed(savedId, { error: errorMessage(error) });
                return;
            }
            await show(saved).catch(() => {});
        },

        disconnect: async (id) => {
            forgetColumns(id);
            forgetDetails(id);
            set((s) => ({ connections: s.connections.filter((c) => c.id !== id) }));
            await commands.disconnect(id);
        },

        loadOtherDatabase: async (id, database) => {
            const schemas = await commands.listSchemas(id, database);
            set((s) => ({
                connections: s.connections.map((c) => (c.id === id ? { ...c, others: { ...c.others, [database]: schemas } } : c)),
            }));
        },

        refresh: async (id, database) => {
            forgetColumns(id);
            forgetDetails(id);
            const c = get().connections.find((c) => c.id === id);
            if (c && database && database !== c.database) return get().loadOtherDatabase(id, database);
            const saved = get().saved.find((s) => s.id === c?.savedId);
            // show() replaces the connection, so other databases' cached schemas reload when shown
            if (saved) await show(saved);
        },

        rename: async (savedId, label) => {
            const saved = await commands.renameSaved(savedId, label);
            set((s) => ({
                saved: s.saved.map((c) => (c.id === savedId ? saved : c)),
                connections: s.connections.map((c) => (c.savedId === savedId ? { ...c, label: saved.label } : c)),
            }));
        },

        update: async (savedId, request, label) => {
            await get().add(await commands.updateSaved(savedId, request, label));
        },

        forget: async (savedId) => {
            await commands.forgetSaved(savedId);
            get().discard(savedId);
        },
    };
});

// Lists the saved connections at launch without connecting: each one connects when the user clicks it,
// so an unreachable server (a production database off the VPN) never stalls or errors at startup.
// shortcut: no per-connection "reconnect automatically" setting yet (spec 5.2); add it if people want some to auto-open
async function restore() {
    useConnections.setState({ saved: await commands.listSaved() });
}
// Outside the Tauri app (a plain browser tab) there is no backend to restore from
restore().catch(() => {});
