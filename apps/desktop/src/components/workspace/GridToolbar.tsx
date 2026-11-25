import { useId, useState, type ComponentProps } from 'react';
import { Columns3, Copy, Download, Minus, Plus, RefreshCw, Undo2 } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/stores/connections';

/** One format the grid's rows can be saved as */
type ExportFormat = { id: string; label: string; ext: string; text: () => string };

export type Limit = { value: number; options: { value: number; label: string }[]; onChange: (value: number) => void };

type Props = {
    /** Each only when the login may; a query result has none */
    onInsert?: () => void;
    /** A table tab's: stages a new column, for review */
    onAddColumn?: () => void;
    onDuplicate?: () => void;
    /** `restore` when the selected rows are already staged for deletion */
    onDelete?: () => void;
    restore?: boolean;
    /** `blocked` says why a refresh isn't possible, when it isn't */
    refresh?: { run: () => void; busy: boolean; blocked?: string };
    limit?: Limit;
    formats: ExportFormat[];
    /** What the export covers, e.g. "1,000 loaded rows" */
    scope: string;
    fileName: string;
    onError: (message: string) => void;
};

function ToolButton({ label, title, ...props }: { label: string } & Omit<ComponentProps<typeof Button>, 'variant' | 'size'>) {
    return <Button type="button" variant="ghost" size="icon-xs" aria-label={label} title={title ?? label} {...props} />;
}

/** DBeaver-style strip under a grid: change rows, reload, export, and how many rows to load */
export function GridToolbar({ onInsert, onAddColumn, onDuplicate, onDelete, restore, refresh, limit, formats, scope, fileName, onError }: Props) {
    const [exportOpen, setExportOpen] = useState(false);
    const limitLabel = useId();
    const editable = onInsert || onDuplicate || onDelete;

    async function exportAs(format: ExportFormat) {
        setExportOpen(false);
        try {
            const path = await save({ defaultPath: `${fileName}.${format.ext}`, filters: [{ name: format.label, extensions: [format.ext] }] });
            if (path) await writeTextFile(path, format.text());
        } catch (error) {
            onError(`Export failed: ${errorMessage(error)}`);
        }
    }

    return (
        <div role="toolbar" aria-label="Rows" className="flex h-8 flex-none items-center gap-0.5 border-t border-border-soft bg-surface px-2">
            {editable && (
                <>
                    <ToolButton label="Add row" title="Add a row, staged until you save" onClick={onInsert} disabled={!onInsert}>
                        <Plus className="size-4" aria-hidden />
                    </ToolButton>
                    <ToolButton
                        label={restore ? 'Restore rows' : 'Delete rows'}
                        title={restore ? 'Take back the delete' : 'Delete the selected rows, staged until you save'}
                        onClick={onDelete}
                        disabled={!onDelete}
                    >
                        {restore ? <Undo2 className="size-4" aria-hidden /> : <Minus className="size-4" aria-hidden />}
                    </ToolButton>
                    <ToolButton label="Duplicate rows" title="Add copies of the selected rows" onClick={onDuplicate} disabled={!onDuplicate}>
                        <Copy className="size-3.5" aria-hidden />
                    </ToolButton>
                    {onAddColumn && (
                        <ToolButton label="Add column" title="Add a column to the table, staged until you apply it" onClick={onAddColumn}>
                            <Columns3 className="size-4" aria-hidden />
                        </ToolButton>
                    )}
                    <span className="mx-1 h-4 w-px flex-none bg-border-soft" aria-hidden />
                </>
            )}
            {refresh && (
                <ToolButton
                    label="Refresh"
                    title={refresh.blocked ?? 'Run it again'}
                    onClick={refresh.run}
                    disabled={refresh.busy || !!refresh.blocked}
                >
                    <RefreshCw className={cn('size-3.5', refresh.busy && 'animate-spin')} aria-hidden />
                </ToolButton>
            )}
            <Popover open={exportOpen} onOpenChange={setExportOpen}>
                <PopoverTrigger asChild>
                    <ToolButton label="Export data" title={`Save ${scope} to a file`}>
                        <Download className="size-3.5" aria-hidden />
                    </ToolButton>
                </PopoverTrigger>
                <PopoverContent side="top" align="start" className="w-44 p-1">
                    <p className="px-2 py-1 text-[11px] text-fg3">Export {scope}</p>
                    {formats.map((f) => (
                        <button
                            key={f.id}
                            type="button"
                            onClick={() => void exportAs(f)}
                            className="flex h-8 w-full items-center rounded-[5px] px-2 text-left text-[13px] outline-none hover:bg-primary-soft focus-visible:bg-primary-soft"
                        >
                            {f.label}
                        </button>
                    ))}
                </PopoverContent>
            </Popover>
            {limit && (
                <div className="ml-auto flex items-center gap-1.5 text-[11px] text-fg3">
                    <span id={limitLabel}>Rows</span>
                    <Select value={String(limit.value)} onValueChange={(v) => limit.onChange(Number(v))}>
                        <SelectTrigger size="sm" aria-labelledby={limitLabel} className="h-6 w-24 text-xs tabular-nums">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper" align="end">
                            {limit.options.map((o) => (
                                <SelectItem key={o.value} value={String(o.value)}>
                                    {o.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            )}
        </div>
    );
}
