import { createContext, memo, useContext } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { KeyRound, Link2, Plus, Table2 } from 'lucide-react';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuDestructiveItem,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { menuKey } from '@/components/shell/Explorer';
import { cn } from '@/lib/utils';
import { FOOTER, HEADER, NODE_WIDTH, ROW, type GraphColumn, type GraphTable, type Mark } from '@/lib/schema-graph';

/** What the nodes can do to their table; null while the diagram can't be edited (a pending apply) */
export type TableActions = {
    addColumn: (table: string) => void;
    renameTable: (table: string) => void;
    dropTable: (table: string) => void;
    renameColumn: (table: string, column: string) => void;
    dropColumn: (table: string, column: string) => void;
};

export const TableActionsContext = createContext<TableActions | null>(null);

type TableNodeData = { table: GraphTable };
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

function Row({ table, column }: { table: string; column: GraphColumn }) {
    const actions = useContext(TableActionsContext);
    const row = (
        <div
            tabIndex={actions && column.mark !== 'dropped' ? 0 : undefined}
            onKeyDown={menuKey}
            style={{ height: ROW }}
            className={cn(
                'relative flex items-center gap-2 px-3 text-[12.5px] outline-none focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
                column.mark === 'new' && 'bg-success-soft',
                column.mark === 'dropped' && 'bg-danger-soft',
            )}
        >
            {/* Left: where a link from another table lands. Right: drag from here to a column to link this one to it */}
            <Handle id={column.name} type="target" position={Position.Left} className="diagram-handle" isConnectable={column.mark !== 'dropped'} />
            <span className="grid size-3.5 flex-none place-items-center">{keyIcon(column.key)}</span>
            <span className={cn('min-w-0 flex-1 truncate', column.mark && markClass[column.mark])}>{column.name}</span>
            <span className="flex-none truncate font-mono text-[11px] text-fg3">{column.type}</span>
            <Handle id={column.name} type="source" position={Position.Right} className="diagram-handle" isConnectable={column.mark !== 'dropped'} />
        </div>
    );
    if (!actions || column.mark === 'dropped') return row;
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem onSelect={() => actions.renameColumn(table, column.name)}>Rename column…</ContextMenuItem>
                <ContextMenuDestructiveItem onSelect={() => actions.dropColumn(table, column.name)}>Drop column</ContextMenuDestructiveItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}

function TableNodeView({ data }: NodeProps<TableFlowNode>) {
    const { table } = data;
    const actions = useContext(TableActionsContext);
    const dropped = table.mark === 'dropped';
    // Dropped tables and a diagram that is applying can't be edited
    const editable = actions && !dropped;
    const header = (
        <div
            tabIndex={editable ? 0 : undefined}
            onKeyDown={menuKey}
            style={{ height: HEADER }}
            className="flex items-center gap-2 border-b border-border-soft bg-header px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
            <Table2 className="size-3.5 flex-none text-fg3" aria-hidden />
            <span className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', table.mark && markClass[table.mark])}>{table.name}</span>
        </div>
    );
    return (
        <div
            style={{ width: NODE_WIDTH }}
            className={cn(
                'overflow-hidden rounded-lg border bg-surface shadow-sm',
                table.mark === 'new' ? 'border-success/60' : dropped ? 'border-danger/60 opacity-70' : 'border-border',
            )}
        >
            {editable ? (
                <ContextMenu>
                    <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
                    <ContextMenuContent>
                        <ContextMenuItem onSelect={() => actions.addColumn(table.name)}>Add column…</ContextMenuItem>
                        <ContextMenuItem onSelect={() => actions.renameTable(table.name)}>Rename table…</ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuDestructiveItem onSelect={() => actions.dropTable(table.name)}>Drop table</ContextMenuDestructiveItem>
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
            <div style={{ height: FOOTER }} className="flex items-center border-t border-border-soft px-1.5">
                {editable && (
                    <button
                        type="button"
                        onClick={() => actions.addColumn(table.name)}
                        className="nodrag nopan flex h-6 items-center gap-1 rounded px-1.5 text-xs text-fg3 outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                        <Plus className="size-3" aria-hidden /> Add column
                    </button>
                )}
            </div>
        </div>
    );
}

export const TableNode = memo(TableNodeView);
