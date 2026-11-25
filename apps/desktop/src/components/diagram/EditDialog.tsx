import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { columnTypes, keyType, type NewColumn, type SchemaChange } from '@/lib/schema-ddl';
import type { Connection } from '@/stores/connections';

export type Edit =
    | { kind: 'createTable' }
    | { kind: 'renameTable'; table: string }
    | { kind: 'addColumn'; table: string }
    | { kind: 'renameColumn'; table: string; column: string };

type Props = {
    edit: Edit | null;
    engine: Connection['kind'];
    /** Names already taken, by table: a table's columns, or every table's name under '' */
    taken: (table: string) => string[];
    onStage: (change: SchemaChange) => void;
    onClose: () => void;
};

const blankColumn = (type: string): NewColumn => ({ name: '', type, nullable: true, default: '', primary: false });

export function EditDialog({ edit, ...rest }: Props) {
    // Each edit starts a fresh form: the key remounts it
    return (
        <Dialog open={edit !== null} onOpenChange={(open) => !open && rest.onClose()}>
            <DialogContent className="sm:max-w-md">{edit && <EditForm key={JSON.stringify(edit)} edit={edit} {...rest} />}</DialogContent>
        </Dialog>
    );
}

function EditForm({ edit, engine, taken, onStage, onClose }: Props & { edit: Edit }) {
    const id = useId();
    // What the name is now, when renaming: keeping it isn't a clash with itself
    const current = edit.kind === 'renameTable' ? edit.table : edit.kind === 'renameColumn' ? edit.column : '';
    const [name, setName] = useState(current);
    const [column, setColumn] = useState<NewColumn>(() => blankColumn(columnTypes[engine][0]));
    const [keyName, setKeyName] = useState('id');

    const scope = edit.kind === 'createTable' || edit.kind === 'renameTable' ? '' : edit.table;
    const trimmed = name.trim();
    const clash = taken(scope).some((n) => n.toLowerCase() === trimmed.toLowerCase() && n !== current);
    const needsType = edit.kind === 'addColumn';
    const invalid =
        !trimmed || clash || trimmed === current || (needsType && !column.type.trim()) || (edit.kind === 'createTable' && !keyName.trim());

    const title = {
        createTable: 'New table',
        renameTable: `Rename ${edit.kind === 'renameTable' ? edit.table : ''}`,
        addColumn: `Add a column to ${edit.kind === 'addColumn' ? edit.table : ''}`,
        renameColumn: `Rename ${edit.kind === 'renameColumn' ? `${edit.table}.${edit.column}` : ''}`,
    }[edit.kind];

    function submit(e: FormEvent) {
        e.preventDefault();
        if (invalid) return;
        if (edit.kind === 'createTable') {
            const key: NewColumn = { name: keyName.trim(), type: keyType[engine], nullable: false, default: '', primary: true };
            onStage({ op: 'createTable', table: trimmed, columns: [key] });
        } else if (edit.kind === 'renameTable') onStage({ op: 'renameTable', table: edit.table, to: trimmed });
        else if (edit.kind === 'renameColumn') onStage({ op: 'renameColumn', table: edit.table, column: edit.column, to: trimmed });
        else onStage({ op: 'addColumn', table: edit.table, column: { ...column, name: trimmed } });
        onClose();
    }

    return (
        <form onSubmit={submit} className="contents">
            <DialogHeader>
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription>Nothing changes in the database until you review and apply it.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-name`}>{edit.kind === 'createTable' || edit.kind === 'renameTable' ? 'Table name' : 'Column name'}</Label>
                    <Input
                        id={`${id}-name`}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        autoFocus
                        spellCheck={false}
                        autoComplete="off"
                        aria-invalid={clash}
                    />
                    {clash && <p className="text-xs text-danger">That name is already used here</p>}
                </div>
                {edit.kind === 'createTable' && (
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor={`${id}-key`}>Primary key column</Label>
                        <Input id={`${id}-key`} value={keyName} onChange={(e) => setKeyName(e.target.value)} spellCheck={false} autoComplete="off" />
                        <p className="text-xs text-fg3">Numbers itself. Add the other columns after the table is made.</p>
                    </div>
                )}
                {edit.kind === 'addColumn' && (
                    <>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`${id}-type`}>Type</Label>
                            <Input
                                id={`${id}-type`}
                                value={column.type}
                                onChange={(e) => setColumn({ ...column, type: e.target.value })}
                                list={`${id}-types`}
                                spellCheck={false}
                                autoComplete="off"
                                className="font-mono"
                            />
                            <datalist id={`${id}-types`}>
                                {columnTypes[engine].map((t) => (
                                    <option key={t} value={t} />
                                ))}
                            </datalist>
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`${id}-default`}>Default</Label>
                            <Input
                                id={`${id}-default`}
                                value={column.default}
                                onChange={(e) => setColumn({ ...column, default: e.target.value })}
                                placeholder="None"
                                spellCheck={false}
                                autoComplete="off"
                                className="font-mono"
                            />
                            <p className="text-xs text-fg3">A SQL expression, written as the database reads it: 0, 'new', now()</p>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <Label htmlFor={`${id}-null`}>Allows NULL</Label>
                            <Switch id={`${id}-null`} checked={column.nullable} onCheckedChange={(nullable) => setColumn({ ...column, nullable })} />
                        </div>
                    </>
                )}
            </div>
            <DialogFooter>
                <Button type="button" variant="ghost" onClick={onClose}>
                    Cancel
                </Button>
                <Button type="submit" disabled={invalid}>
                    Stage change
                </Button>
            </DialogFooter>
        </form>
    );
}
