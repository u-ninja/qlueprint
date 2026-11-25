import { useEffect, useId, useState, type FormEvent } from 'react';
import type { TableDetails } from '@/bindings';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { schemasOf } from '@/components/shell/Explorer';
import { columnTypes, foreignKeyName, indexName, keyType, type NewColumn } from '@/lib/schema-ddl';
import type { Target } from '@/lib/schema-graph';
import { detailsOf } from '@/lib/table-details';
import { useConnections, type Connection } from '@/stores/connections';
import { useSchemaEdit, type Edit } from '@/stores/schema-edit';

/** A table's details, or null when it isn't in the database (yet): a table staged to be created has none */
function useDetails(target: Target, table: string | null) {
    const [loaded, setLoaded] = useState<{ table: string; details: TableDetails | null } | null>(null);
    useEffect(() => {
        if (!table) return;
        let current = true;
        detailsOf({ ...target, table }).then(
            (details) => current && setLoaded({ table, details }),
            () => current && setLoaded({ table, details: null }),
        );
        return () => {
            current = false;
        };
    }, [target.connectionId, target.database, target.schema, table]);
    return loaded?.table === table ? loaded.details : null;
}

const blankColumn = (type: string): NewColumn => ({ name: '', type, nullable: true, default: '', primary: false });

/** The one edit dialog for the window: opened from the graph, the inspector or a table's grid */
export function SchemaEditDialog() {
    const dialog = useSchemaEdit((s) => s.dialog);
    const closeEdit = useSchemaEdit((s) => s.closeEdit);
    const connection = useConnections((s) => s.connections.find((c) => c.id === dialog?.target.connectionId));
    return (
        <Dialog open={dialog !== null} onOpenChange={(open) => !open && closeEdit()}>
            <DialogContent className="sm:max-w-md">
                {dialog && connection && <EditForm key={JSON.stringify(dialog)} target={dialog.target} edit={dialog.edit} c={connection} />}
            </DialogContent>
        </Dialog>
    );
}

const titleOf = (edit: Edit) => {
    switch (edit.kind) {
        case 'createTable':
            return 'New table';
        case 'renameTable':
            return `Rename ${edit.table}`;
        case 'addColumn':
            return `Add a column to ${edit.table}`;
        case 'renameColumn':
            return `Rename ${edit.table}.${edit.column}`;
        case 'addIndex':
            return `Add an index to ${edit.table}`;
        case 'addRelation':
            return `Link ${edit.table} to another table`;
    }
};

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <Label htmlFor={id}>{label}</Label>
            {children}
            {hint && <p className="text-xs text-fg3">{hint}</p>}
        </div>
    );
}

function EditForm({ target, edit, c }: { target: Target; edit: Edit; c: Connection }) {
    const id = useId();
    const { stage, closeEdit } = useSchemaEdit.getState();
    const engine = c.kind;
    const tableNames = (schemasOf(c, target.database).find((s) => s.name === target.schema)?.tables ?? []).filter((t) => !t.view).map((t) => t.name);
    const table = edit.kind === 'createTable' ? null : edit.table;
    const details = useDetails(target, table);
    const columns = details?.columns.map((x) => x.name) ?? [];

    // What the name is now, when renaming: keeping it isn't a clash with itself
    const current = edit.kind === 'renameTable' ? edit.table : edit.kind === 'renameColumn' ? edit.column : '';
    const [name, setName] = useState(current);
    const [column, setColumn] = useState<NewColumn>(() => blankColumn(columnTypes[engine][0]));
    const [keyName, setKeyName] = useState('id');
    const [indexColumns, setIndexColumns] = useState<string[]>(edit.kind === 'addIndex' && edit.column ? [edit.column] : []);
    const [unique, setUnique] = useState(false);
    const [fkColumn, setFkColumn] = useState(edit.kind === 'addRelation' ? (edit.column ?? '') : '');
    const [refTable, setRefTable] = useState('');
    const [refColumn, setRefColumn] = useState('');
    const refDetails = useDetails(target, refTable || null);

    // Once the target table is read, its primary key is the natural column to point at
    useEffect(() => {
        if (!refDetails) return;
        setRefColumn((refDetails.columns.find((x) => x.key === 'PK') ?? refDetails.columns[0])?.name ?? '');
    }, [refDetails]);

    const trimmed = name.trim();
    const taken = edit.kind === 'createTable' || edit.kind === 'renameTable' ? tableNames : columns;
    const clash = taken.some((n) => n.toLowerCase() === trimmed.toLowerCase() && n !== current);
    const needsName = ['createTable', 'renameTable', 'addColumn', 'renameColumn'].includes(edit.kind);
    const derivedIndex = table ? indexName(table, indexColumns, unique) : '';
    const invalid =
        (needsName && (!trimmed || clash || trimmed === current)) ||
        (edit.kind === 'addColumn' && !column.type.trim()) ||
        (edit.kind === 'createTable' && !keyName.trim()) ||
        (edit.kind === 'addIndex' && !indexColumns.length) ||
        (edit.kind === 'addRelation' && (!fkColumn || !refTable || !refColumn));

    function submit(e: FormEvent) {
        e.preventDefault();
        if (invalid) return;
        switch (edit.kind) {
            case 'createTable': {
                const key: NewColumn = { name: keyName.trim(), type: keyType[engine], nullable: false, default: '', primary: true };
                stage(target, { op: 'createTable', table: trimmed, columns: [key] });
                break;
            }
            case 'renameTable':
                stage(target, { op: 'renameTable', table: edit.table, to: trimmed });
                break;
            case 'renameColumn':
                stage(target, { op: 'renameColumn', table: edit.table, column: edit.column, to: trimmed });
                break;
            case 'addColumn':
                stage(target, { op: 'addColumn', table: edit.table, column: { ...column, name: trimmed } });
                break;
            case 'addIndex':
                stage(target, { op: 'createIndex', table: edit.table, name: trimmed || derivedIndex, columns: indexColumns, unique });
                break;
            case 'addRelation':
                stage(target, {
                    op: 'addForeignKey',
                    table: edit.table,
                    column: fkColumn,
                    refTable,
                    refColumn,
                    name: trimmed || foreignKeyName(edit.table, fkColumn),
                });
                break;
        }
        closeEdit();
    }

    return (
        <form onSubmit={submit} className="contents">
            <DialogHeader>
                <DialogTitle>{titleOf(edit)}</DialogTitle>
                <DialogDescription>Nothing changes in the database until you review and apply it.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
                {needsName && (
                    <Field id={`${id}-name`} label={edit.kind === 'createTable' || edit.kind === 'renameTable' ? 'Table name' : 'Column name'}>
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
                    </Field>
                )}
                {edit.kind === 'createTable' && (
                    <Field id={`${id}-key`} label="Primary key column" hint="Numbers itself. Add the other columns after the table is made.">
                        <Input id={`${id}-key`} value={keyName} onChange={(e) => setKeyName(e.target.value)} spellCheck={false} autoComplete="off" />
                    </Field>
                )}
                {edit.kind === 'addColumn' && (
                    <>
                        <Field id={`${id}-type`} label="Type">
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
                        </Field>
                        <Field id={`${id}-default`} label="Default" hint="A SQL expression, written as the database reads it: 0, 'new', now()">
                            <Input
                                id={`${id}-default`}
                                value={column.default}
                                onChange={(e) => setColumn({ ...column, default: e.target.value })}
                                placeholder="None"
                                spellCheck={false}
                                autoComplete="off"
                                className="font-mono"
                            />
                        </Field>
                        <div className="flex items-center justify-between gap-3">
                            <Label htmlFor={`${id}-null`}>Allows NULL</Label>
                            <Switch id={`${id}-null`} checked={column.nullable} onCheckedChange={(nullable) => setColumn({ ...column, nullable })} />
                        </div>
                    </>
                )}
                {edit.kind === 'addIndex' && (
                    <>
                        <fieldset className="flex flex-col gap-1.5">
                            <legend className="mb-1.5 text-sm font-medium">Columns, in order</legend>
                            <div className="flex max-h-44 flex-col gap-0.5 overflow-auto rounded-md border p-1">
                                {columns.map((col) => {
                                    const at = indexColumns.indexOf(col);
                                    return (
                                        <label
                                            key={col}
                                            className="flex h-7 cursor-pointer items-center gap-2 rounded px-2 text-[13px] hover:bg-hover"
                                        >
                                            <input
                                                type="checkbox"
                                                checked={at >= 0}
                                                onChange={(e) =>
                                                    setIndexColumns(e.target.checked ? [...indexColumns, col] : indexColumns.filter((x) => x !== col))
                                                }
                                            />
                                            <span className="min-w-0 flex-1 truncate">{col}</span>
                                            {at >= 0 && <span className="font-mono text-[11px] text-fg3 tabular-nums">{at + 1}</span>}
                                        </label>
                                    );
                                })}
                            </div>
                        </fieldset>
                        <Field id={`${id}-name`} label="Index name">
                            <Input
                                id={`${id}-name`}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder={derivedIndex}
                                spellCheck={false}
                                autoComplete="off"
                                className="font-mono"
                            />
                        </Field>
                        <div className="flex items-center justify-between gap-3">
                            <Label htmlFor={`${id}-unique`}>Unique</Label>
                            <Switch id={`${id}-unique`} checked={unique} onCheckedChange={setUnique} />
                        </div>
                    </>
                )}
                {edit.kind === 'addRelation' && (
                    <>
                        <Field id={`${id}-from`} label={`Column in ${edit.table}`}>
                            <Select value={fkColumn} onValueChange={setFkColumn}>
                                <SelectTrigger id={`${id}-from`} className="w-full">
                                    <SelectValue placeholder="Choose a column" />
                                </SelectTrigger>
                                <SelectContent>
                                    {columns.map((col) => (
                                        <SelectItem key={col} value={col}>
                                            {col}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field id={`${id}-table`} label="Points at table">
                            <Select
                                value={refTable}
                                onValueChange={(t) => {
                                    setRefTable(t);
                                    setRefColumn('');
                                }}
                            >
                                <SelectTrigger id={`${id}-table`} className="w-full">
                                    <SelectValue placeholder="Choose a table" />
                                </SelectTrigger>
                                <SelectContent>
                                    {tableNames.map((t) => (
                                        <SelectItem key={t} value={t}>
                                            {t}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field id={`${id}-ref`} label="and its column">
                            <Select value={refColumn} onValueChange={setRefColumn} disabled={!refDetails}>
                                <SelectTrigger id={`${id}-ref`} className="w-full">
                                    <SelectValue placeholder="Choose a column" />
                                </SelectTrigger>
                                <SelectContent>
                                    {refDetails?.columns.map((x) => (
                                        <SelectItem key={x.name} value={x.name}>
                                            {x.name} · {x.typeName}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                    </>
                )}
            </div>
            <DialogFooter>
                <Button type="button" variant="ghost" onClick={closeEdit}>
                    Cancel
                </Button>
                <Button type="submit" disabled={invalid}>
                    Stage change
                </Button>
            </DialogFooter>
        </form>
    );
}
