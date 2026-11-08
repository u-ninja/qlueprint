import { create } from 'zustand';
import { commands, type InstanceStatus, type LocalInstance, type SavedConnection } from '@/bindings';
import { errorMessage, useConnections, type ConnectionState } from './connections';
import { useQuery } from './query';
import { useUi } from './ui';

export type LifecycleAction = 'start' | 'stop' | 'restart';

/** How an instance's status reads as a status dot */
export const statusDot: Record<InstanceStatus, ConnectionState> = {
    running: 'open',
    starting: 'connecting',
    creating: 'connecting',
    stopped: 'closed',
    removed: 'closed',
    unknown: 'closed',
    failed: 'failed',
    missing: 'failed',
};

export const statusLabel: Record<InstanceStatus, string> = {
    running: 'Running',
    starting: 'Starting',
    creating: 'Being created',
    stopped: 'Stopped',
    removed: 'Container removed, data kept',
    unknown: 'Docker isn’t running',
    failed: 'Failed',
    missing: 'Missing',
};

type LocalState = {
    /** The "Create local database" dialog */
    createOpen: boolean;
    setCreateOpen: (open: boolean) => void;
    instances: LocalInstance[];
    loading: boolean;
    error: string | null;
    /** The action running per instance id, so its row can show it */
    busy: Record<string, string>;
    /** The last failed action per instance id */
    errors: Record<string, string>;
    load: () => Promise<void>;
    lifecycle: (id: string, action: LifecycleAction) => Promise<void>;
    remove: (id: string) => Promise<void>;
    deleteData: (id: string, confirm: string) => Promise<void>;
};

const run: Record<LifecycleAction, (id: string) => Promise<LocalInstance>> = {
    start: commands.startLocalDatabase,
    stop: commands.stopLocalDatabase,
    restart: commands.restartLocalDatabase,
};

const busyText: Record<LifecycleAction, string> = { start: 'starting…', stop: 'stopping…', restart: 'restarting…' };

// The instance list lives in Rust (local_instances.json); this mirrors it with live status
export const useLocal = create<LocalState>()((set, get) => {
    async function track(id: string, label: string, action: () => Promise<void>) {
        set((s) => ({ busy: { ...s.busy, [id]: label }, errors: { ...s.errors, [id]: '' } }));
        try {
            await action();
        } catch (error) {
            set((s) => ({ errors: { ...s.errors, [id]: errorMessage(error) } }));
            throw error;
        } finally {
            set((s) => {
                const { [id]: _, ...busy } = s.busy;
                return { busy };
            });
        }
    }

    return {
        createOpen: false,
        setCreateOpen: (createOpen) => set({ createOpen }),
        instances: [],
        loading: false,
        error: null,
        busy: {},
        errors: {},

        load: async () => {
            set({ loading: true });
            try {
                set({ instances: await commands.listLocalInstances(), error: null });
            } catch (error) {
                set({ error: errorMessage(error) });
            } finally {
                set({ loading: false });
            }
        },

        lifecycle: (id, action) =>
            track(id, busyText[action], async () => {
                const updated = await run[action](id);
                set((s) => ({ instances: s.instances.map((i) => (i.id === id ? updated : i)) }));
            }),

        remove: (id) =>
            track(id, 'removing…', async () => {
                await commands.removeLocalDatabase(id);
                await get().load();
            }),

        deleteData: (id, confirm) =>
            track(id, 'deleting…', async () => {
                const savedId = get().instances.find((i) => i.id === id)?.savedConnectionId;
                await commands.deleteLocalDatabaseData(id, confirm);
                // Rust forgot the connection along with the data
                if (savedId) useConnections.getState().discard(savedId);
                await get().load();
            }),
    };
});

/** Shows a newly saved connection, picks it in the toolbar and switches to the workspace */
export async function openConnection(saved: SavedConnection) {
    const { saved: list, add, open } = useConnections.getState();
    if (list.some((s) => s.id === saved.id)) await open(saved.id);
    else await add(saved);
    useQuery.getState().setConnectionId(saved.id);
    useUi.getState().setView('workspace');
}

/** Opens an instance's saved connection (connecting it if needed) in the workspace */
export async function openInstance(instance: LocalInstance) {
    const saved = useConnections.getState().saved.find((s) => s.id === instance.savedConnectionId);
    if (!saved) throw new Error('This database has no saved connection any more.');
    await openConnection(saved);
}
