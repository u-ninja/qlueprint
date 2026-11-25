// Schema edits staged from anywhere (the graph, the table inspector, a table's grid) and kept per
// schema, so one list is reviewed and applied wherever it's opened from. Nothing runs until Apply.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { commands } from '@/bindings';
import { changeSql, type SchemaChange, type Staged } from '@/lib/schema-ddl';
import { targetKey, type Positions, type Target } from '@/lib/schema-graph';
import { errorMessage, useConnections } from './connections';
import { useQuery } from './query';

/** What the shared edit dialog is asking for; the drops need no question and are staged directly */
export type Edit =
    | { kind: 'createTable' }
    | { kind: 'renameTable'; table: string }
    | { kind: 'addColumn'; table: string }
    | { kind: 'renameColumn'; table: string; column: string }
    | { kind: 'addIndex'; table: string; column?: string }
    /** A foreign key from `column`, when the column is already chosen */
    | { kind: 'addRelation'; table: string; column?: string };

type SchemaEditState = {
    /** Edits waiting for review, in the order they run, by schema (`targetKey`) */
    changes: Record<string, Staged[]>;
    /** Why a schema's last apply stopped */
    errors: Record<string, string>;
    /** Where the user left each table in a graph, by schema: remembered between launches */
    positions: Record<string, Positions>;
    /** Bumped when a database changed, so graphs read their schema again */
    version: number;
    /** The schema being applied */
    applying: string | null;
    /** The open edit dialog; one for the whole window */
    dialog: { target: Target; edit: Edit } | null;
    openEdit: (target: Target, edit: Edit) => void;
    closeEdit: () => void;
    stage: (target: Target, change: SchemaChange) => void;
    unstage: (target: Target, id: string) => void;
    discard: (target: Target) => void;
    move: (target: Target, positions: Positions) => void;
    resetPositions: (target: Target) => void;
    /** Runs a schema's staged edits one by one; one that fails stops the rest, which stay staged with it */
    apply: (target: Target) => Promise<void>;
    /** Reads schemas again, for a database that changed without this window knowing */
    reload: () => void;
};

/** Where a run stopped: what ran stays ran, and the rest is still staged */
function stoppedAt(done: number, total: number) {
    const left = total - done;
    const ran = done ? `${done} of ${total} changes ran. ` : '';
    return `${ran}${left === 1 ? 'The failed change is' : `The failed change and the ${left - 1} after it are`} still staged.`;
}

const NONE: Staged[] = [];
/** A schema's staged edits; the same empty list each time, so a selector doesn't re-render for nothing */
export const changesOf = (s: Pick<SchemaEditState, 'changes'>, target: Target) => s.changes[targetKey(target)] ?? NONE;

/** Every schema with staged edits, for the Changes panel */
export const pendingTargets = (s: Pick<SchemaEditState, 'changes'>): Target[] =>
    Object.entries(s.changes)
        .filter(([, list]) => list.length)
        .map(([key]) => {
            const [connectionId, database, schema] = JSON.parse(key) as string[];
            return { connectionId, database, schema };
        });

export const useSchemaEdit = create<SchemaEditState>()(
    persist(
        (set, get) => ({
            changes: {},
            errors: {},
            positions: {},
            version: 0,
            applying: null,
            dialog: null,
            openEdit: (target, edit) => set({ dialog: { target, edit } }),
            closeEdit: () => set({ dialog: null }),
            stage: (target, change) =>
                set((s) => {
                    const key = targetKey(target);
                    const { [key]: _, ...errors } = s.errors;
                    return { changes: { ...s.changes, [key]: [...changesOf(s, target), { ...change, id: crypto.randomUUID() }] }, errors };
                }),
            unstage: (target, id) =>
                set((s) => ({ changes: { ...s.changes, [targetKey(target)]: changesOf(s, target).filter((c) => c.id !== id) } })),
            discard: (target) =>
                set((s) => {
                    const key = targetKey(target);
                    const { [key]: _, ...changes } = s.changes;
                    const { [key]: __, ...errors } = s.errors;
                    return { changes, errors };
                }),
            move: (target, moved) =>
                set((s) => {
                    const key = targetKey(target);
                    return { positions: { ...s.positions, [key]: { ...s.positions[key], ...moved } } };
                }),
            resetPositions: (target) =>
                set((s) => {
                    const { [targetKey(target)]: _, ...rest } = s.positions;
                    return { positions: rest };
                }),
            reload: () => set((s) => ({ version: s.version + 1 })),
            apply: async (target) => {
                const key = targetKey(target);
                const changes = changesOf(get(), target);
                const kind = useConnections.getState().connections.find((c) => c.id === target.connectionId)?.kind;
                if (!kind || !changes.length || get().applying) return;
                set({ applying: key });
                let done = 0;
                let error: string | null = null;
                try {
                    for (const change of changes) {
                        await commands.runQuery(target.connectionId, changeSql(kind, target.schema, change), target.database || null, true, false);
                        done++;
                    }
                } catch (e) {
                    error = `${errorMessage(e)} ${stoppedAt(done, changes.length)}`;
                }
                // What ran stays ran: the explorer, the open graphs and the open tables read the database again
                if (done)
                    await useConnections
                        .getState()
                        .refresh(target.connectionId, target.database || undefined)
                        .catch(() => {});
                set((s) => {
                    const { [key]: _, ...errors } = s.errors;
                    return {
                        applying: null,
                        changes: { ...s.changes, [key]: changes.slice(done) },
                        errors: error ? { ...errors, [key]: error } : errors,
                        version: s.version + (done ? 1 : 0),
                    };
                });
                if (done) {
                    const { tables, queryTable } = useQuery.getState();
                    for (const t of tables)
                        if (t.connectionId === target.connectionId && t.database === target.database && t.schema === target.schema)
                            void queryTable(t.id, {});
                }
            },
        }),
        { name: 'qc-schema-edit', partialize: ({ positions }) => ({ positions }) },
    ),
);
