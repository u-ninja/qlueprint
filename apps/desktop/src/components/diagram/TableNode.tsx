import { createContext, memo, useContext } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { KeyRound, Link2, Network, Plus, Table2 } from 'lucide-react';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuDestructiveItem,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { menuKey } from '@/components/shell/Explorer';
import { cn, count } from '@/lib/utils';
import { FOOTER, HEADER, NODE_WIDTH, ROW, type GraphColumn, type GraphTable, type Mark, type Target } from '@/lib/schema-graph';
import { useQuery } from '@/stores/query';
import { useSchemaEdit } from '@/stores/schema-edit';

/** Which schema and tab a graph is drawn for; null while edits can't be made (an apply is running) */
export type GraphContext = { target: Target; tabId: string };
export const GraphContextContext = createContext<GraphContext | null>(null);

type TableNodeData = { table: GraphTable; focus: boolean };
export type TableFlowNode = Node<TableNodeData, 'table'>;

const markClass: Record<Mark, string> = {
    new: 'text-success',
    dropped: 'text-danger line-through',
    renamed: 'text-warning',
};

const keyIcon = (key: string | null) =>
    key === 'PK' ? (
        <KeyRound className="size-3 text-warning" aria-label="Primary key" />
    ) : key === 'FK' ? (
        <Link2 className="size-3 text-primary-text" aria-label="Foreign key" />
    ) : null;

/** Handle ids carry a side so one column can be an edge's end on either edge of its table */
export const handleId = (column: string, side: 'l' | 'r') => `${column}:${side}`;
export const columnOf = (handle: string) => handle.slice(0, -2);

function Row({ table, column }: { table: string; column: GraphColumn }) {
    const graph = useContext(GraphContextContext);
    const row = (
        <div
            tabIndex={graph && column.mark !== 'dropped' ? 0 : undefined}
            onKeyDown={menuKey}
            style={{ height: ROW }}
            className={cn(
                'relative flex items-center gap-2 px-3 text-[12.5px] outline-none focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
                column.mark === 'new' && 'bg-success-soft',
                column.mark === 'dropped' && 'bg-danger-soft',
            )}
        >
            {/* A dot on each side so an edge can leave by the side that faces the other table. Dragging from a dot to another column links the first to it */}
            <Handle id={handleId(column.name, 'l')} type="source" position={Position.Left} className="diagram-handle" isConnectable={column.mark !== 'dropped'} />
            <span className="grid size-3.5 flex-none place-items-center">{keyIcon(column.key)}</span>
            <span className={cn('min-w-0 flex-1 truncate', column.mark && markClass[column.mark])}>{column.name}</span>
            <span className="flex-none truncate font-mono text-[11px] text-fg3">{column.type}</span>
            <Handle id={handleId(column.name, 'r')} type="source" position={Position.Right} className="diagram-handle" isConnectable={column.mark !== 'dropped'} />
        </div>
    );
    if (!graph || column.mark === 'dropped') return row;
    const { openEdit, stage } = useSchemaEdit.getState();
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem onSelect={() => openEdit(graph.target, { kind: 'renameColumn', table, column: column.name })}>
                    Rename column…
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => openEdit(graph.target, { kind: 'addRelation', table, column: column.name })}>
                    Link to a table…
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => openEdit(graph.target, { kind: 'addIndex', table, column: column.name })}>
                    Add index…
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuDestructiveItem onSelect={() => stage(graph.target, { op: 'dropColumn', table, column: column.name })}>
                    Drop column
                </ContextMenuDestructiveItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}

function TableNodeView({ data }: NodeProps<TableFlowNode>) {
    const { table, focus } = data;
    const graph = useContext(GraphContextContext);
    const dropped = table.mark === 'dropped';
    // Dropped tables can't be edited, and nothing can while an apply is running
    const editable = graph && !dropped;
    const connected = table.more.length;
    const showConnected = () => graph && useQuery.getState().expandGraph(graph.tabId, table.name);
    const header = (
        <div
            tabIndex={editable ? 0 : undefined}
            onKeyDown={menuKey}
            style={{ height: HEADER }}
            className="flex items-center gap-2 rounded-t-[7px] border-b border-border-soft bg-header px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
            <Table2 className="size-3.5 flex-none text-fg3" aria-hidden />
            <span className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', table.mark && markClass[table.mark])}>{table.name}</span>
        </div>
    );
    const footerButton =
        'nodrag nopan flex h-6 items-center gap-1 rounded px-1.5 text-xs text-fg3 outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50';
    return (
        <div
            style={{ width: NODE_WIDTH }}
            className={cn(
                'rounded-lg border bg-surface shadow-sm',
                table.mark === 'new' ? 'border-success/60' : dropped ? 'border-danger/60 opacity-70' : focus ? 'border-primary' : 'border-border',
            )}
        >
            {editable ? (
                <ContextMenu>
                    <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
                    <ContextMenuContent>
                        <ContextMenuItem onSelect={() => useSchemaEdit.getState().openEdit(graph.target, { kind: 'addColumn', table: table.name })}>
                            Add column…
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => useSchemaEdit.getState().openEdit(graph.target, { kind: 'addIndex', table: table.name })}>
                            Add index…
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => useSchemaEdit.getState().openEdit(graph.target, { kind: 'addRelation', table: table.name })}>
                            Link to a table…
                        </ContextMenuItem>
                        {connected > 0 && <ContextMenuItem onSelect={showConnected}>Show connected tables</ContextMenuItem>}
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => useSchemaEdit.getState().openEdit(graph.target, { kind: 'renameTable', table: table.name })}>
                            Rename table…
                        </ContextMenuItem>
                        <ContextMenuDestructiveItem
                            onSelect={() => useSchemaEdit.getState().stage(graph.target, { op: 'dropTable', table: table.name })}
                        >
                            Drop table
                        </ContextMenuDestructiveItem>
                    </ContextMenuContent>
                </ContextMenu>
            ) : (
                header
            )}
            <div>
                {table.columns.map((c) => (
                    <Row key={c.name} table={table.name} column={c} />
                ))}
            </div>
            <div style={{ height: FOOTER }} className="flex items-center justify-between border-t border-border-soft px-1.5">
                {editable ? (
                    <button
                        type="button"
                        onClick={() => useSchemaEdit.getState().openEdit(graph.target, { kind: 'addColumn', table: table.name })}
                        className={footerButton}
                    >
                        <Plus className="size-3" aria-hidden /> Add column
                    </button>
                ) : (
                    <span />
                )}
                {connected > 0 && (
                    <button type="button" onClick={showConnected} className={footerButton} title={table.more.join(', ')}>
                        <Network className="size-3" aria-hidden /> {count(connected, 'more table')}
                    </button>
                )}
            </div>
        </div>
    );
}

export const TableNode = memo(TableNodeView);
