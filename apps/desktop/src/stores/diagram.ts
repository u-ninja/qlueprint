import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { commands } from '@/bindings';
import { changeSql, type SchemaChange, type Staged } from '@/lib/schema-ddl';
import { targetKey, type Positions, type Target } from '@/lib/schema-graph';
import { errorMessage, useConnections } from './connections';
import { useUi } from './ui';

type DiagramState = {
    /** The schema drawn; null until one is opened from the explorer or picked on the page */
    target: Target | null;
    /** Edits waiting for review, in the order they run. They belong to `target` */
    changes: Staged[];
    /** Where the user left each table, by schema (`targetKey`): remembered between launches */
    positions: Record<string, Positions>;
    /** Bumped when the database changed, so the page loads the schema again */
    version: number;
    applying: boolean;
    /** Why the last apply stopped, or why a schema couldn't be switched to */
    error: string | null;
    /** Shows the diagram of a schema. Pending edits stay with their schema: another one waits until they're applied or discarded */
    open: (target: Target) => void;
    stage: (change: SchemaChange) => void;
    unstage: (id: string) => void;
    discard: () => void;
    move: (positions: Positions) => void;
    resetPositions: () => void;
    /** Runs the staged edits one by one; one that fails stops the rest and stays staged with the ones after it */
    apply: () => Promise<void>;
    /** Reads the schema again, for a database that changed without this page knowing */
    reload: () => void;
};

/** Where a run stopped: what ran stays ran, and the rest is still staged */
function stoppedAt(done: number, total: number) {
    const left = total - done;
    const ran = done ? `${done} of ${total} changes ran. ` : '';
    return `${ran}${left === 1 ? 'The failed change is' : `The failed change and the ${left - 1} after it are`} still staged.`;
}

export const useDiagram = create<DiagramState>()(
    persist(
        (set, get) => ({
            target: null,
            changes: [],
            positions: {},
            version: 0,
            applying: false,
            error: null,
            open: (target) => {
                const { target: shown, changes } = get();
                const same = shown && targetKey(shown) === targetKey(target);
                if (!same && changes.length) {
                    set({ error: 'Apply or discard the pending changes before opening another schema.' });
                } else set({ target, error: null });
                useUi.getState().setView('diagram');
            },
            stage: (change) => set((s) => ({ changes: [...s.changes, { ...change, id: crypto.randomUUID() }], error: null })),
            unstage: (id) => set((s) => ({ changes: s.changes.filter((c) => c.id !== id), error: null })),
            discard: () => set({ changes: [], error: null }),
            move: (moved) =>
                set((s) => {
                    if (!s.target) return s;
                    const key = targetKey(s.target);
                    return { positions: { ...s.positions, [key]: { ...s.positions[key], ...moved } } };
                }),
            resetPositions: () =>
                set((s) => {
                    if (!s.target) return s;
                    const { [targetKey(s.target)]: _, ...rest } = s.positions;
                    return { positions: rest };
                }),
            reload: () => set((s) => ({ version: s.version + 1 })),
            apply: async () => {
                const { target, changes, applying } = get();
                const kind = useConnections.getState().connections.find((c) => c.id === target?.connectionId)?.kind;
                if (!target || !kind || !changes.length || applying) return;
                set({ applying: true, error: null });
                let done = 0;
                try {
                    for (const change of changes) {
                        await commands.runQuery(target.connectionId, changeSql(kind, target.schema, change), target.database || null, true, false);
                        done++;
                    }
                } catch (error) {
                    set({ error: `${errorMessage(error)} ${stoppedAt(done, changes.length)}` });
                }
                // What ran stays ran: out of the list, and the explorer and the diagram read the database again
                if (done)
                    await useConnections
                        .getState()
                        .refresh(target.connectionId, target.database || undefined)
                        .catch(() => {});
                set((s) => ({ changes: s.changes.slice(done), applying: false, version: s.version + (done ? 1 : 0) }));
            },
        }),
        {
            name: 'qc-diagram',
            partialize: ({ positions }) => ({ positions }),
        },
    ),
);
