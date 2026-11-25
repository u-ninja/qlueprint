import { useEffect, useMemo, useRef, useState } from 'react';
import {
    Background,
    Controls,
    MarkerType,
    ReactFlow,
    ReactFlowProvider,
    useReactFlow,
    type Connection as Link,
    type Edge,
    type EdgeMouseHandler,
    type OnNodeDrag,
    useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useShallow } from 'zustand/react/shallow';
import { LayoutGrid, Plus, RotateCw, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorMessage, useConnections, type Connection } from '@/stores/connections';
import { useDiagram } from '@/stores/diagram';
import { foreignKeyName, supportsForeignKeyDdl } from '@/lib/schema-ddl';
import { layout, loadGraph, NODE_WIDTH, targetKey, withChanges, type Graph, type Relation, type Target } from '@/lib/schema-graph';
import { cn, count } from '@/lib/utils';
import { schemasOf } from '@/components/shell/Explorer';
import { EditDialog, type Edit } from './EditDialog';
import { ReviewPanel } from './ReviewPanel';
import { TableActionsContext, TableNode, type TableActions, type TableFlowNode } from './TableNode';

const nodeTypes = { table: TableNode };
const proOptions = { hideAttribution: true };

/** The tables of the target's schema as the explorer lists them, views left out: a view has no keys to draw */
function tablesOf(c: Connection, t: Target) {
    return (schemasOf(c, t.database).find((s) => s.name === t.schema)?.tables ?? []).filter((x) => !x.view).map((x) => x.name);
}

/** The schema shown first on a connection: one with tables to draw, else the first */
const defaultSchema = (c: Connection) => c.schemas.find((s) => s.tables.some((t) => !t.view)) ?? c.schemas[0];

/** The target a schema on `c` is drawn as: MySQL's schema is its database, the rest use the connection's */
const targetOn = (c: Connection, schema: string): Target => ({ connectionId: c.id, database: c.kind === 'mysql' ? schema : c.database, schema });

/** The live link on a column, if it has one */
const relationOn = (graph: Graph | null, table: string, column: string) =>
    graph?.relations.find((r) => r.mark !== 'dropped' && r.table === table && r.column === column);

const edgeId = (r: Relation) => `${r.table}.${r.column}->${r.refTable}.${r.refColumn}`;

function Picker({ c, target }: { c: Connection | undefined; target: Target | null }) {
    const connections = useConnections((s) => s.connections);
    const open = useDiagram((s) => s.open);
    const locked = useDiagram((s) => s.changes.length > 0);
    return (
        <>
            <Select
                value={c?.id ?? ''}
                disabled={locked}
                onValueChange={(id) => {
                    const next = connections.find((x) => x.id === id);
                    const schema = next && defaultSchema(next);
                    if (next && schema) open(targetOn(next, schema.name));
                }}
            >
                <SelectTrigger size="sm" aria-label="Connection" className="w-44 min-w-24">
                    <SelectValue placeholder="Connection" />
                </SelectTrigger>
                <SelectContent position="popper">
                    {connections.map((x) => (
                        <SelectItem key={x.id} value={x.id}>
                            {x.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <Select value={target?.schema ?? ''} disabled={!c || locked} onValueChange={(schema) => c && open(targetOn(c, schema))}>
                <SelectTrigger size="sm" aria-label="Schema" className="w-40 min-w-24">
                    <SelectValue placeholder="Schema" />
                </SelectTrigger>
                <SelectContent position="popper">
                    {c?.schemas.map((s) => (
                        <SelectItem key={s.name} value={s.name}>
                            {s.name}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </>
    );
}

function Diagram({ c, target }: { c: Connection; target: Target }) {
    const { changes, positions, version, applying, stage, unstage, move, resetPositions, reload } = useDiagram(
        useShallow((s) => ({
            changes: s.changes,
            positions: s.positions,
            version: s.version,
            applying: s.applying,
            stage: s.stage,
            unstage: s.unstage,
            move: s.move,
            resetPositions: s.resetPositions,
            reload: s.reload,
        })),
    );
    const { fitView } = useReactFlow();
    const names = useMemo(() => tablesOf(c, target), [c, target]);
    const namesKey = useMemo(() => JSON.stringify(names), [names]);
    const key = targetKey(target);

    // What the database has: read again when the schema, its tables or an apply says it changed
    const [base, setBase] = useState<{ for: string; graph: Graph } | null>(null);
    const [progress, setProgress] = useState(0);
    const [loadError, setLoadError] = useState<string | null>(null);
    useEffect(() => {
        let current = true;
        setLoadError(null);
        setProgress(0);
        loadGraph(
            target,
            names,
            (n) => current && setProgress(n),
            () => !current,
        ).then(
            (graph) => current && setBase({ for: key, graph }),
            (error) => current && setLoadError(errorMessage(error)),
        );
        return () => {
            current = false;
        };
        // `names` is read through its key: a new array of the same tables isn't a change
    }, [key, namesKey, version]);

    const graph = useMemo(() => (base?.for === key ? withChanges(base.graph, changes) : null), [base, key, changes]);
    const auto = useMemo(() => (graph ? layout(graph) : {}), [graph]);
    // Read when nodes are rebuilt, not a reason to rebuild them: a drag already moved its node. Cleared positions (Auto layout) are
    const saved = positions[key];
    const savedRef = useRef(saved);
    savedRef.current = saved;
    const hasSaved = saved !== undefined;

    const [nodes, setNodes, onNodesChange] = useNodesState<TableFlowNode>([]);
    useEffect(() => {
        setNodes(
            (graph?.tables ?? []).map((table) => ({
                id: table.name,
                type: 'table',
                position: savedRef.current?.[table.name] ?? auto[table.name] ?? { x: 0, y: 0 },
                data: { table },
                width: NODE_WIDTH,
            })),
        );
    }, [graph, auto, hasSaved]);
    const onNodeDragStop: OnNodeDrag<TableFlowNode> = (_, node) => move({ [node.id]: node.position });

    // Frame everything once a different schema has loaded
    const framed = useRef('');
    useEffect(() => {
        if (graph && framed.current !== key && nodes.length) {
            framed.current = key;
            requestAnimationFrame(() => void fitView({ padding: 0.15, duration: 0 }));
        }
    }, [graph, nodes.length, key, fitView]);

    const edges: Edge[] = useMemo(
        () =>
            (graph?.relations ?? []).map((r) => {
                const color = r.mark === 'new' ? 'var(--success)' : r.mark === 'dropped' ? 'var(--danger)' : 'var(--fg3)';
                return {
                    id: edgeId(r),
                    source: r.table,
                    sourceHandle: r.column,
                    target: r.refTable,
                    targetHandle: r.refColumn,
                    type: 'smoothstep',
                    deletable: r.mark !== 'dropped',
                    markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
                    style: { stroke: color, strokeWidth: 1.5, strokeDasharray: r.mark === 'dropped' ? '4 4' : undefined },
                    data: { relation: r },
                };
            }),
        [graph],
    );

    // Edits
    const [edit, setEdit] = useState<Edit | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const editable = !applying;
    const actions: TableActions | null = useMemo(
        () =>
            editable
                ? {
                      addColumn: (table) => setEdit({ kind: 'addColumn', table }),
                      renameTable: (table) => setEdit({ kind: 'renameTable', table }),
                      dropTable: (table) => stage({ op: 'dropTable', table }),
                      renameColumn: (table, column) => setEdit({ kind: 'renameColumn', table, column }),
                      dropColumn: (table, column) => stage({ op: 'dropColumn', table, column }),
                  }
                : null,
        [editable, stage],
    );
    const taken = (table: string) =>
        table ? (graph?.tables.find((t) => t.name === table)?.columns.map((x) => x.name) ?? []) : (graph?.tables.map((t) => t.name) ?? []);

    // Dragging from one column's dot to another's links them: the first table's column now references the second's
    const onConnect = (link: Link) => {
        if (!editable || !link.sourceHandle || !link.targetHandle) return;
        if (!supportsForeignKeyDdl(c.kind)) {
            setNotice('SQLite can’t add a foreign key to a table that exists. Create it in a new table, or run the SQL yourself.');
            return;
        }
        if (relationOn(graph, link.source, link.sourceHandle)) {
            setNotice(`${link.source}.${link.sourceHandle} already references a column. Unlink it first.`);
            return;
        }
        setNotice(null);
        stage({
            op: 'addForeignKey',
            table: link.source,
            column: link.sourceHandle,
            refTable: link.target,
            refColumn: link.targetHandle,
            name: foreignKeyName(link.source, link.sourceHandle),
        });
    };

    // Deleting a link: a staged one is taken back, an existing one is dropped by its name
    const [selected, setSelected] = useState<Relation | null>(null);
    const onEdgeClick: EdgeMouseHandler = (_, edge) => setSelected((edge.data as { relation: Relation }).relation);
    const unlink = (r: Relation) => {
        const staged = changes.find((x) => x.op === 'addForeignKey' && x.table === r.table && x.column === r.column);
        if (staged) unstage(staged.id);
        else if (!r.name) setNotice('This database doesn’t name its foreign keys, so one can’t be dropped from here.');
        else stage({ op: 'dropForeignKey', table: r.table, column: r.column, name: r.name });
        setSelected(null);
    };
    const canUnlink = selected && selected.mark !== 'dropped' && editable;

    // Through the connection, so the explorer and this page both see tables made or dropped elsewhere
    const refresh = () =>
        void useConnections
            .getState()
            .refresh(c.id, target.database || undefined)
            .then(reload);

    const loading = !graph && !loadError;
    return (
        <TableActionsContext.Provider value={actions}>
            <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex h-9 flex-none items-center gap-1.5 border-b border-border-soft px-3">
                    <Button variant="ghost" size="xs" disabled={!editable || !graph} onClick={() => setEdit({ kind: 'createTable' })}>
                        <Plus aria-hidden /> New table
                    </Button>
                    <Button
                        variant="ghost"
                        size="xs"
                        disabled={!graph}
                        onClick={() => (resetPositions(), requestAnimationFrame(() => void fitView({ padding: 0.15 })))}
                    >
                        <LayoutGrid aria-hidden /> Auto layout
                    </Button>
                    <Button variant="ghost" size="xs" disabled={loading || applying || changes.length > 0} onClick={refresh}>
                        <RotateCw aria-hidden /> Reload
                    </Button>
                    {canUnlink && (
                        <Button variant="ghost" size="xs" onClick={() => unlink(selected)}>
                            <Unlink aria-hidden /> Unlink {selected.table}.{selected.column}
                        </Button>
                    )}
                    <span className="ml-auto truncate text-xs text-fg3 tabular-nums">
                        {graph ? `${count(graph.tables.length, 'table')} · ${count(graph.relations.length, 'link')}` : null}
                    </span>
                </div>
                <div className="relative min-h-0 flex-1">
                    {loadError ? (
                        <p role="alert" className="grid h-full place-items-center p-6 text-danger">
                            {loadError}
                        </p>
                    ) : loading ? (
                        <p role="status" className="grid h-full place-items-center p-6 text-fg3">
                            <span className="tabular-nums">
                                Reading {count(names.length, 'table')}… {progress.toLocaleString()} of {names.length.toLocaleString()}
                            </span>
                        </p>
                    ) : graph && graph.tables.length === 0 ? (
                        <p className="grid h-full place-items-center p-6 text-fg3">No tables in {target.schema}. Use New table to start one.</p>
                    ) : (
                        <ReactFlow<TableFlowNode>
                            nodes={nodes}
                            edges={edges}
                            nodeTypes={nodeTypes}
                            onNodesChange={onNodesChange}
                            onNodeDragStop={onNodeDragStop}
                            onConnect={onConnect}
                            onEdgeClick={onEdgeClick}
                            onPaneClick={() => setSelected(null)}
                            onEdgesDelete={(deleted) => deleted.forEach((e) => unlink((e.data as { relation: Relation }).relation))}
                            nodesConnectable={editable}
                            minZoom={0.1}
                            maxZoom={1.5}
                            proOptions={proOptions}
                            onlyRenderVisibleElements
                            className={cn('diagram', !editable && 'opacity-70')}
                        >
                            <Background gap={20} size={1} color="var(--border-soft)" />
                            <Controls showInteractive={false} />
                        </ReactFlow>
                    )}
                    {notice && (
                        <p
                            role="status"
                            className="absolute bottom-3 left-1/2 max-w-md -translate-x-1/2 rounded-md border border-border bg-elev px-3 py-2 text-[13px] shadow-sm"
                        >
                            {notice}
                        </p>
                    )}
                </div>
                <ReviewPanel kind={c.kind} schema={target.schema} />
            </div>
            <EditDialog edit={edit} engine={c.kind} taken={taken} onStage={stage} onClose={() => setEdit(null)} />
        </TableActionsContext.Provider>
    );
}

export function DiagramPage() {
    const target = useDiagram((s) => s.target);
    const connection = useConnections((s) => s.connections.find((c) => c.id === target?.connectionId));
    const first = useConnections((s) => s.connections[0]);
    const open = useDiagram((s) => s.open);
    const error = useDiagram((s) => s.error);

    // The first open connection's first schema, when nothing was picked from the explorer
    useEffect(() => {
        if (!connection && first) {
            const schema = defaultSchema(first);
            if (schema) open(targetOn(first, schema.name));
        }
    }, [connection, first, open]);

    return (
        <main className="flex h-full min-w-0 flex-col overflow-hidden bg-editor">
            <header className="flex h-11 flex-none items-center gap-2 border-b border-border-soft px-3">
                <h1 className="mr-2 text-sm font-medium">Diagram</h1>
                <Picker c={connection} target={target} />
            </header>
            {error && (
                <p role="alert" className="border-b border-border-soft bg-danger-soft px-3 py-1.5 text-[13px] text-danger">
                    {error}
                </p>
            )}
            {connection && target ? (
                <ReactFlowProvider>
                    <Diagram key={target.connectionId} c={connection} target={target} />
                </ReactFlowProvider>
            ) : (
                <p className="grid flex-1 place-items-center p-6 text-fg3">Connect to a database to see how its tables relate.</p>
            )}
        </main>
    );
}
