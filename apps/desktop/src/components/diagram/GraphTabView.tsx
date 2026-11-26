import { useEffect, useMemo, useRef, useState } from 'react';
import {
    Background,
    Controls,
    MarkerType,
    ReactFlow,
    ReactFlowProvider,
    useNodesState,
    useReactFlow,
    ConnectionMode,
    type Connection as Link,
    type Edge,
    type EdgeMouseHandler,
    type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { LayoutGrid, Plus, RotateCw, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { schemasOf } from '@/components/shell/Explorer';
import { foreignKeyName, supportsForeignKeyDdl } from '@/lib/schema-ddl';
import { layout, loadGraph, NODE_WIDTH, targetKey, withChanges, type Graph, type Relation, type Target } from '@/lib/schema-graph';
import { cn, count } from '@/lib/utils';
import { errorMessage, useConnections } from '@/stores/connections';
import type { GraphTab } from '@/stores/query';
import { changesOf, useSchemaEdit } from '@/stores/schema-edit';
import { columnOf, GraphContextContext, handleId, TableNode, type GraphContext, type TableFlowNode } from './TableNode';
import { SchemaChanges } from './SchemaChanges';

const nodeTypes = { table: TableNode };
const proOptions = { hideAttribution: true };

const edgeId = (r: Relation) => `${r.table}.${r.column}->${r.refTable}.${r.refColumn}`;

/** The live link on a column, if it has one */
const relationOn = (graph: Graph | null, table: string, column: string) =>
    graph?.relations.find((r) => r.mark !== 'dropped' && r.table === table && r.column === column);

/** A table's connections drawn as a graph, or a whole schema's, with its tables editable in place */
function GraphCanvas({ tab }: { tab: GraphTab }) {
    const c = useConnections((s) => s.connections.find((x) => x.id === tab.connectionId));
    const target: Target = useMemo(() => ({ connectionId: tab.connectionId, database: tab.database, schema: tab.schema }), [tab]);
    const key = targetKey(target);
    const changes = useSchemaEdit((s) => changesOf(s, target));
    const positions = useSchemaEdit((s) => s.positions[key]);
    const version = useSchemaEdit((s) => s.version);
    const applying = useSchemaEdit((s) => s.applying !== null);
    const { stage, unstage, move, resetPositions, reload, openEdit } = useSchemaEdit.getState();
    const { fitView } = useReactFlow();

    // A whole-schema graph expands every table of the schema as the explorer lists them, views left out
    const schemaTables = c
        ? (schemasOf(c, target.database).find((s) => s.name === target.schema)?.tables ?? []).filter((t) => !t.view).map((t) => t.name)
        : [];
    const expanded = tab.table ? tab.expanded : schemaTables;
    const expandedKey = JSON.stringify(expanded);

    // What the database has: read again when the tables shown, or an apply, say it changed
    const [base, setBase] = useState<{ for: string; graph: Graph } | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    useEffect(() => {
        let current = true;
        setLoadError(null);
        loadGraph(target, expanded, () => !current).then(
            (graph) => current && setBase({ for: `${tab.id}${expandedKey}`, graph }),
            (error) => current && setLoadError(errorMessage(error)),
        );
        return () => {
            current = false;
        };
        // `expanded` is read through its key: a new array of the same tables isn't a change
    }, [tab.id, expandedKey, version]);

    const graph = useMemo(
        () => (base?.for === `${tab.id}${expandedKey}` ? withChanges(base.graph, changes) : null),
        [base, tab.id, expandedKey, changes],
    );
    const auto = useMemo(() => (graph ? layout(graph) : {}), [graph]);

    // Read when nodes are rebuilt, not a reason to rebuild them: a drag already moved its node. Cleared positions (Auto layout) are
    const savedRef = useRef(positions);
    savedRef.current = positions;
    const hasSaved = positions !== undefined;

    const [nodes, setNodes, onNodesChange] = useNodesState<TableFlowNode>([]);
    useEffect(() => {
        setNodes(
            (graph?.tables ?? []).map((table) => ({
                id: table.name,
                type: 'table',
                position: savedRef.current?.[table.name] ?? auto[table.name] ?? { x: 0, y: 0 },
                data: { table, focus: table.name === tab.table },
                width: NODE_WIDTH,
            })),
        );
    }, [graph, auto, hasSaved, tab.table]);
    const onNodeDragStop: OnNodeDrag<TableFlowNode> = (_, node) => move(target, { [node.id]: node.position });

    // Frame everything once a graph has loaded, and again when it grows
    const framed = useRef('');
    useEffect(() => {
        const at = `${tab.id}${expandedKey}`;
        if (graph && framed.current !== at && nodes.length) {
            framed.current = at;
            requestAnimationFrame(() => void fitView({ padding: 0.15, duration: 0 }));
        }
    }, [graph, nodes.length, tab.id, expandedKey, fitView]);

    // Which side an edge leaves and enters by follows where the two tables sit, so it never runs back behind them
    const centres = useMemo(() => new Map(nodes.map((n) => [n.id, n.position.x + NODE_WIDTH / 2])), [nodes]);
    const edges: Edge[] = useMemo(
        () =>
            (graph?.relations ?? []).map((r) => {
                const childRight = (centres.get(r.table) ?? 0) >= (centres.get(r.refTable) ?? 0);
                const self = r.table === r.refTable;
                const color = r.mark === 'new' ? 'var(--success)' : r.mark === 'dropped' ? 'var(--danger)' : 'var(--fg3)';
                return {
                    id: edgeId(r),
                    source: r.table,
                    sourceHandle: handleId(r.column, self || !childRight ? 'r' : 'l'),
                    target: r.refTable,
                    targetHandle: handleId(r.refColumn, self || childRight ? 'r' : 'l'),
                    type: 'smoothstep',
                    deletable: r.mark !== 'dropped',
                    markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
                    style: { stroke: color, strokeWidth: 1.5, strokeDasharray: r.mark === 'dropped' ? '4 4' : undefined },
                    data: { relation: r },
                };
            }),
        [graph, centres],
    );

    const [notice, setNotice] = useState<string | null>(null);
    const editable = !applying;
    const context: GraphContext | null = useMemo(() => (editable ? { target, tabId: tab.id } : null), [editable, target, tab.id]);

    // Dragging from one column's dot to another's links them: the first table's column now references the second's
    const onConnect = (connection: Link) => {
        if (!editable || !connection.sourceHandle || !connection.targetHandle) return;
        const link = { source: connection.source, target: connection.target, sourceHandle: columnOf(connection.sourceHandle), targetHandle: columnOf(connection.targetHandle) };
        if (!c || !supportsForeignKeyDdl(c.kind)) {
            setNotice('SQLite can’t add a foreign key to a table that exists. Create it in a new table, or run the SQL yourself.');
            return;
        }
        if (relationOn(graph, link.source, link.sourceHandle)) {
            setNotice(`${link.source}.${link.sourceHandle} already references a column. Unlink it first.`);
            return;
        }
        setNotice(null);
        stage(target, {
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
        if (staged) unstage(target, staged.id);
        else if (!r.name) setNotice('This database doesn’t name its foreign keys, so one can’t be dropped from here.');
        else stage(target, { op: 'dropForeignKey', table: r.table, column: r.column, name: r.name });
        setSelected(null);
    };
    const canUnlink = selected && selected.mark !== 'dropped' && editable;

    // Through the connection, so the explorer and this tab both see tables made or dropped elsewhere
    const refresh = () =>
        void useConnections
            .getState()
            .refresh(target.connectionId, target.database || undefined)
            .then(reload);

    if (!c) return <p className="grid flex-1 place-items-center p-6 text-fg3">This connection is closed. Reconnect to see the graph.</p>;
    const loading = !graph && !loadError;
    return (
        <GraphContextContext.Provider value={context}>
            <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex h-9 flex-none items-center gap-1.5 border-b border-border-soft px-3">
                    <Button variant="ghost" size="xs" disabled={!editable || !graph} onClick={() => openEdit(target, { kind: 'createTable' })}>
                        <Plus aria-hidden /> New table
                    </Button>
                    <Button
                        variant="ghost"
                        size="xs"
                        disabled={!graph}
                        onClick={() => (resetPositions(target), requestAnimationFrame(() => void fitView({ padding: 0.15 })))}
                    >
                        <LayoutGrid aria-hidden /> Auto layout
                    </Button>
                    <Button variant="ghost" size="xs" disabled={loading || applying} onClick={refresh}>
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
                            Reading tables…
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
                            connectionMode={ConnectionMode.Loose}
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
                <div className="flex max-h-[40%] flex-none flex-col border-t border-border bg-chrome empty:hidden">
                    <SchemaChanges target={target} heading={false} />
                </div>
            </div>
        </GraphContextContext.Provider>
    );
}

/** The graph tab's body: a table and the tables connected to it, drawn and editable in the workspace */
export function GraphTabView({ tab }: { tab: GraphTab }) {
    return (
        <ReactFlowProvider>
            <GraphCanvas tab={tab} />
        </ReactFlowProvider>
    );
}
