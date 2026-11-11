import type { ColumnInfo } from '@/bindings';
import { useConnections } from '@/stores/connections';
import { activeConnection, activeDatabase, currentQuery, useQuery } from '@/stores/query';
import { catalogOf, columnsOf, findTable, homeSchema, sqlName } from './columns';
import { NAME, referenced, unquote, type Ref } from './sql-refs';
import { monaco } from './monaco';

type Kind = monaco.languages.CompletionItemKind;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// After these, a table name is expected
const TABLE_BEFORE = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE']);
const KEYWORDS =
    'SELECT FROM WHERE AND OR NOT NULL IS IN LIKE BETWEEN AS ON JOIN LEFT INNER GROUP ORDER BY HAVING LIMIT OFFSET DISTINCT COUNT INSERT INTO VALUES UPDATE SET DELETE CASE WHEN THEN ELSE END'.split(
        ' ',
    );

/** What the current tab's connection and database contain, from the column cache; undefined when unknown */
async function catalog() {
    // The tab being edited: each query tab has its own connection and database
    const tab = currentQuery(useQuery.getState());
    const connection = activeConnection(useConnections.getState().connections, tab.connectionId);
    if (!connection) return undefined;
    const { kind } = connection;
    const database = activeDatabase(connection, tab);
    const catalog = await columnsOf(connection.id, database).then(catalogOf, () => undefined);
    if (!catalog) return undefined;
    const home = homeSchema(kind, database);
    const tables = catalog.tables;
    const find = (table: string, schema?: string) => findTable(catalog, table, home, schema);
    /** The x in "x.": an alias or table of this statement (its columns), or a schema (its tables) */
    const resolve = (qualifier: string, refs: Ref[]) => {
        const q = unquote(qualifier);
        const ref = refs.find((r) => r.alias && same(r.alias, q)) ?? refs.find((r) => same(r.table, q));
        const target = ref ? find(ref.table, ref.schema) : find(q);
        return { target, schema: target ? undefined : [...tables.keys()].find((s) => same(s, q)) };
    };
    return { kind, home, tables, find, resolve };
}

// Typed prefix → statement, with tab stops; "table" offers the home schema's tables to pick from
const SNIPPETS: [string, string, string][] = [
    ['sel', 'SELECT … FROM … WHERE', 'SELECT ${1:*}\nFROM ${2:TABLE}\nWHERE ${3:condition};'],
    ['ins', 'INSERT INTO … VALUES', 'INSERT INTO ${1:TABLE} (${2:columns})\nVALUES (${3:values});'],
    ['upd', 'UPDATE … SET … WHERE', 'UPDATE ${1:TABLE}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};'],
    ['del', 'DELETE FROM … WHERE', 'DELETE FROM ${1:TABLE}\nWHERE ${2:condition};'],
    ['join', 'JOIN … ON', 'JOIN ${1:TABLE} ON ${2:condition}'],
    ['ljoin', 'LEFT JOIN … ON', 'LEFT JOIN ${1:TABLE} ON ${2:condition}'],
    ['grp', 'Count by a column', 'SELECT ${1:column}, COUNT(*)\nFROM ${2:TABLE}\nGROUP BY ${1:column}\nORDER BY COUNT(*) DESC;'],
    ['case', 'CASE WHEN … END', 'CASE\n  WHEN ${1:condition} THEN ${2:result}\n  ELSE ${3:otherwise}\nEND'],
    ['cte', 'WITH … AS (…) SELECT', 'WITH ${1:name} AS (\n  ${2:SELECT 1}\n)\nSELECT * FROM ${1:name};'],
];

/** Suggests schemas, tables and columns of the tab's connection and database, plus statement snippets */
async function provideCompletionItems(model: monaco.editor.ITextModel, position: monaco.Position): Promise<monaco.languages.CompletionList> {
    const known = await catalog();
    if (!known) return { suggestions: [] };
    const { kind, home, tables, find, resolve } = known;

    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    const before = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, word.startColumn));
    const refs = referenced(model.getValue());
    const { Field, Struct, Module, Keyword, Snippet } = monaco.languages.CompletionItemKind;

    const item = (label: string, insertText: string, k: Kind, detail: string, rank: string): monaco.languages.CompletionItem => ({
        label: { label, description: detail },
        insertText,
        kind: k,
        detail,
        range,
        sortText: `${rank}${label.toLowerCase()}`,
    });
    const columnItems = (schema: string, table: string, rank: string) =>
        (tables.get(schema)?.get(table) ?? []).map((c) => item(c.name, sqlName(kind, c.name), Field, `${table} · ${c.typeName}`, rank));
    const tableItems = (schema: string, qualify: boolean, rank: string) =>
        [...(tables.get(schema)?.keys() ?? [])].map((t) =>
            item(t, qualify ? `${sqlName(kind, schema)}.${sqlName(kind, t)}` : sqlName(kind, t), Struct, schema, rank),
        );
    // After "x." : x is an alias, a table, or a schema
    const qualifier = new RegExp(String.raw`(${NAME})\s*\.\s*$`).exec(before)?.[1];
    if (qualifier) {
        const { target, schema } = resolve(qualifier, refs);
        if (target) return { suggestions: columnItems(target.schema, target.table, '0') };
        return { suggestions: schema ? tableItems(schema, false, '0') : [] };
    }

    const schemaItems = () => [...tables.keys()].filter((s) => s !== home).map((s) => item(s, sqlName(kind, s), Module, 'schema', '2'));
    const allTables = () => [...tables.keys()].flatMap((s) => tableItems(s, s !== home, s === home ? '1' : '3'));

    const previous = /([A-Za-z_]+)\s*$/.exec(before)?.[1]?.toUpperCase();
    if (previous && TABLE_BEFORE.has(previous)) return { suggestions: [...allTables(), ...schemaItems()] };

    // Anywhere else: the named tables' columns first, then tables, then keywords, then snippets
    const named = refs.map((r) => find(r.table, r.schema)).filter((t) => t !== undefined);
    // A pick-list of tables at each TABLE stop; | and , would end the list, so names with them are left out
    const homeTables = [...(tables.get(home)?.keys() ?? [])].filter((t) => !/[|,\\$}]/.test(t)).slice(0, 60);
    const tablePick = homeTables.length ? `|${homeTables.map((t) => sqlName(kind, t)).join(',')}|` : ':table';
    return {
        suggestions: [
            ...named.flatMap((t) => columnItems(t.schema, t.table, '0')),
            ...allTables(),
            ...KEYWORDS.map((k) => item(k, k, Keyword, '', '4')),
            ...SNIPPETS.map(([prefix, label, body]) => ({
                ...item(
                    prefix,
                    body.replace(/\$\{(\d+):TABLE\}/g, (_, n) => `\${${n}${tablePick}}`),
                    Snippet,
                    label,
                    '5',
                ),
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: {
                    value: '```sql\n' + body.replace(/\$\{\d+:([^}]*)\}/g, (_, text: string) => (text === 'TABLE' ? 'table' : text)) + '\n```',
                },
            })),
        ],
    };
}

const MAX_HOVER_COLUMNS = 25;

/** Hovering a table shows its columns; hovering a column, its type and table */
async function provideHover(model: monaco.editor.ITextModel, position: monaco.Position): Promise<monaco.languages.Hover | null> {
    const word = model.getWordAtPosition(position);
    if (!word) return null;
    const known = await catalog();
    if (!known) return null;
    const { tables, find, resolve } = known;
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
    const refs = referenced(model.getValue());
    const columnOf = (schema: string, table: string) =>
        tables
            .get(schema)
            ?.get(table)
            ?.find((c) => same(c.name, word.word));
    const columnHover = (schema: string, table: string, c: ColumnInfo) => ({
        range,
        contents: [{ value: `**${c.name}** \`${c.typeName}\`` }, { value: `Column of \`${schema}.${table}\`` }],
    });
    const tableHover = (schema: string, table: string) => {
        const columns = tables.get(schema)?.get(table) ?? [];
        const rows = columns.slice(0, MAX_HOVER_COLUMNS).map((c) => `| ${c.name} | \`${c.typeName}\` |`);
        const more = columns.length > MAX_HOVER_COLUMNS ? `\n\n…and ${columns.length - MAX_HOVER_COLUMNS} more` : '';
        return {
            range,
            contents: [
                { value: `**${table}** · ${schema} · ${columns.length} columns` },
                { value: `| Column | Type |\n|---|---|\n${rows.join('\n')}${more}` },
            ],
        };
    };

    // "x.word": a column of x (an alias or a table), or a table of schema x
    const qualifier = new RegExp(String.raw`(${NAME})\s*\.\s*$`).exec(before)?.[1];
    if (qualifier) {
        const { target, schema } = resolve(qualifier, refs);
        const column = target && columnOf(target.schema, target.table);
        if (target && column) return columnHover(target.schema, target.table, column);
        const table = schema && find(word.word, schema);
        return table ? tableHover(table.schema, table.table) : null;
    }
    const table = find(word.word);
    if (table) return tableHover(table.schema, table.table);
    // A bare column: from the tables this statement names
    for (const r of refs) {
        const t = find(r.table, r.schema);
        const column = t && columnOf(t.schema, t.table);
        if (t && column) return columnHover(t.schema, t.table, column);
    }
    return null;
}

let registered = false;

/** Once per app: Monaco providers are global, so a second editor mount mustn't add a second one */
export function registerSqlCompletion() {
    if (registered) return;
    registered = true;
    monaco.languages.registerCompletionItemProvider('pgsql', { triggerCharacters: ['.'], provideCompletionItems });
    monaco.languages.registerHoverProvider('pgsql', { provideHover });
}
