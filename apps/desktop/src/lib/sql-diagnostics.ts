// Underlines in the query editor: syntax errors from a SQL parser in the tab's dialect, UPDATE/DELETE
// without WHERE, and tables the connection doesn't have (with a "Change to …" quick fix).
import { useConnections, type Connection } from '@/stores/connections';
import { activeConnection, activeDatabase, useQuery, type QueryTab } from '@/stores/query';
import { catalogOf, columnsOf, homeSchema, type Catalog } from './columns';
import { CHECKED, closest, firstKeyword, isAccepted, readableParseError, splitStatements, unguardedWrite, type Finding } from './sql-lint';
import { quoteName } from './sql-quote';
import { NAME, referenced, unquote } from './sql-refs';
import { monaco } from './monaco';

const OWNER = 'querycraft';
const DELAY = 400;

type Parser = { astify: (sql: string, opt?: { database: string }) => unknown };
type ParseError = { message?: string; location?: { start: { offset: number }; end: { offset: number } } };

/** Each engine's parser build and the name its astify takes for the dialect */
const dialects: Record<Connection['kind'], { load: () => Promise<unknown>; name: string }> = {
    postgres: { load: () => import('node-sql-parser/build/postgresql'), name: 'PostgresQL' },
    mysql: { load: () => import('node-sql-parser/build/mysql'), name: 'MySQL' },
    mssql: { load: () => import('node-sql-parser/build/transactsql'), name: 'TransactSQL' },
    sqlite: { load: () => import('node-sql-parser/build/sqlite'), name: 'Sqlite' },
};

// One parser per dialect, loaded the first time a tab on that engine is checked: each is a few hundred KB
const parsers = new Map<Connection['kind'], Promise<Parser>>();
const parserFor = (kind: Connection['kind']) => {
    let parser = parsers.get(kind);
    if (!parser) {
        // CommonJS builds: the bundler puts Parser on the module or on its default export
        parser = dialects[kind].load().then((m) => {
            const mod = m as unknown as { Parser?: new () => Parser; default?: { Parser: new () => Parser } };
            return new (mod.Parser ?? mod.default!.Parser)();
        });
        parsers.set(kind, parser);
    }
    return parser;
};

/** A statement's syntax error, offsets within it; null when it parses */
type Syntax = { from: number; to: number; message: string } | null;

// Results by dialect and statement text, so a pause in typing only parses the statements that changed
const syntaxCache = new Map<string, Syntax>();
const CACHED_STATEMENTS = 500;

function syntaxError(parser: Parser, kind: Connection['kind'], text: string): Syntax {
    const key = `${kind}\0${text}`;
    let result = syntaxCache.get(key);
    if (result !== undefined) return result;
    try {
        parser.astify(text, { database: dialects[kind].name });
        result = null;
    } catch (error) {
        const { message = '', location } = error as ParseError;
        result = { from: location?.start.offset ?? 0, to: location?.end.offset ?? 0, message: readableParseError(message) };
    }
    if (syntaxCache.size >= CACHED_STATEMENTS) syntaxCache.clear();
    syntaxCache.set(key, result);
    return result;
}

/** The query tab a model belongs to: the editor keys each model by its tab's id */
const tabOf = (model: monaco.editor.ITextModel): QueryTab | undefined =>
    useQuery.getState().queries.find((q) => q.id && model.uri.toString().endsWith(q.id));

/** Tables named after FROM / JOIN / UPDATE / INTO that the database doesn't have, with the likely intended name */
function unknownTables(kind: Connection['kind'], text: string, start: number, catalog: Catalog, home: string): Finding[] {
    // Names a WITH defines are tables of the statement's own
    const ctes = new Set([...text.matchAll(new RegExp(`(${NAME})\\s+AS\\s*\\(`, 'gi'))].map((m) => unquote(m[1]).toLowerCase()));
    const findings: Finding[] = [];
    for (const ref of referenced(text)) {
        const known = catalog.index.get((ref.schema ?? home).toLowerCase());
        // Another database's schema, a CTE, or a table that exists: nothing to flag
        if (!known || ctes.has(ref.table.toLowerCase()) || known.tables.has(ref.table.toLowerCase())) continue;
        const at = start + ref.at;
        const guess = closest(ref.table, known.tables.values());
        findings.push({
            start: at,
            end: at + ref.token.length,
            severity: 'warning',
            message: `No table “${ref.table}” in ${known.schema}.${guess ? ` Did you mean “${guess}”?` : ''}`,
            ...(guess && {
                fix: {
                    title: `Change to “${guess}”`,
                    text: /^["`[]/.test(ref.token) ? quoteName(kind, guess) : guess,
                },
            }),
        });
    }
    return findings;
}

async function check(model: monaco.editor.ITextModel) {
    const tab = tabOf(model);
    if (!tab || model.isDisposed()) return;
    const version = model.getVersionId();
    const connection = activeConnection(useConnections.getState().connections, tab.connectionId);
    const kind = connection?.kind ?? 'postgres';
    const statements = splitStatements(model.getValue());
    const findings: Finding[] = [];

    const parser = await parserFor(kind).catch(() => undefined);
    for (const statement of statements) {
        const write = unguardedWrite(statement);
        if (write) findings.push(write);
        if (!parser || !CHECKED.has(firstKeyword(statement.text)) || isAccepted(statement.text)) continue;
        const syntax = syntaxError(parser, kind, statement.text);
        if (syntax) {
            const at = statement.start + syntax.from;
            findings.push({ start: at, end: Math.max(at + 1, statement.start + syntax.to), severity: 'error', message: syntax.message });
        }
    }

    if (connection) {
        const database = activeDatabase(connection, tab);
        const columns = await columnsOf(connection.id, database).catch(() => undefined);
        const catalog = columns?.length ? catalogOf(columns) : undefined;
        if (catalog) for (const s of statements) findings.push(...unknownTables(kind, s.text, s.start, catalog, homeSchema(kind, database)));
    }

    // Typed on while this ran: the next check has the current text
    if (model.isDisposed() || model.getVersionId() !== version) return;
    monaco.editor.setModelMarkers(
        model,
        OWNER,
        findings.map((f) => {
            const from = model.getPositionAt(f.start);
            const to = model.getPositionAt(f.end);
            return {
                startLineNumber: from.lineNumber,
                startColumn: from.column,
                endLineNumber: to.lineNumber,
                endColumn: to.column,
                message: f.message,
                severity: f.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
                source: 'QueryCraft',
                // The quick fix's replacement text rides on the marker's code
                ...(f.fix && { code: JSON.stringify(f.fix) }),
            };
        }),
    );
}

let registered = false;

/** Once per app: checks every SQL model as it changes, and again when its tab's connection or database does */
export function registerSqlDiagnostics() {
    if (registered) return;
    registered = true;

    const timers = new WeakMap<monaco.editor.ITextModel, ReturnType<typeof setTimeout>>();
    const schedule = (model: monaco.editor.ITextModel) => {
        clearTimeout(timers.get(model));
        timers.set(
            model,
            setTimeout(() => void check(model), DELAY),
        );
    };
    const watch = (model: monaco.editor.ITextModel) => {
        schedule(model);
        model.onDidChangeContent(() => schedule(model));
    };
    monaco.editor.getModels().forEach(watch);
    monaco.editor.onDidCreateModel(watch);

    // A new connection, database or successful run changes what's known: check again
    const recheck = () => monaco.editor.getModels().forEach(schedule);
    useQuery.subscribe((s, prev) => {
        if (
            s.queries !== prev.queries &&
            s.queries.some(
                (q, i) =>
                    q.connectionId !== prev.queries[i]?.connectionId || q.database !== prev.queries[i]?.database || q.last !== prev.queries[i]?.last,
            )
        )
            recheck();
    });
    useConnections.subscribe((s, prev) => s.connections !== prev.connections && recheck());

    monaco.languages.registerCodeActionProvider('pgsql', {
        provideCodeActions: (model, _range, context) => ({
            actions: context.markers
                .filter((m) => m.source === 'QueryCraft' && typeof m.code === 'string')
                .map((marker) => {
                    const fix = JSON.parse(marker.code as string) as { title: string; text: string };
                    return {
                        title: fix.title,
                        kind: 'quickfix',
                        isPreferred: true,
                        diagnostics: [marker],
                        edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: marker, text: fix.text } }] },
                    };
                }),
            dispose: () => {},
        }),
    });
}
