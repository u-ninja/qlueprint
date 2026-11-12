// Connection strings to and from connection settings. Self-contained (no `@/` imports) so a plain
// `node --experimental-strip-types` script can check it.

export type StringEngine = 'postgres' | 'mysql' | 'mariadb' | 'sqlite' | 'mssql';

/** Postgres' TLS modes; MySQL's are read as these (REQUIRED is require, VERIFY_IDENTITY verify-full). Same as Rust's SslMode */
export type SslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

/** How a SQL Server connection signs in. Same as Rust's MssqlAuth */
export type MssqlAuthKind = 'sql_login' | 'entra_interactive' | 'azure_cli' | 'managed_identity' | 'entra_password';

/** Each server engine's port when a string leaves it out */
export const defaultPort: Record<Exclude<StringEngine, 'sqlite'>, number> = {
    postgres: 5432,
    mysql: 3306,
    mariadb: 3306,
    mssql: 1433,
};

/** What a connection string says; anything it leaves out is absent (host and port get defaults) */
export type Parsed = {
    engine: StringEngine;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    /** SQLite only */
    path?: string;
    /** Postgres and MySQL: what sslmode, ssl-mode or ssl says */
    sslMode?: SslMode;
    /** A CA certificate file: sslrootcert, ssl-ca */
    sslCa?: string;
    /** SQL Server only: a named instance (host\SQLEXPRESS) */
    instance?: string;
    auth?: MssqlAuthKind;
    encrypt?: boolean;
    trustServerCertificate?: boolean;
    /** SQL Server: a user-assigned managed identity's client ID (its User Id) */
    clientId?: string;
};

type ParseResult = { ok: true; value: Parsed } | { ok: false; error: string };

const schemes = new Map<string, StringEngine>([
    ['postgres', 'postgres'],
    ['postgresql', 'postgres'],
    ['mysql', 'mysql'],
    ['mariadb', 'mariadb'],
    ['sqlite', 'sqlite'],
    ['file', 'sqlite'],
    ['sqlserver', 'mssql'],
]);

/**
 * Each TLS mode in order: Postgres' name for it, MySQL's (its label and ssl-mode value; MySQL has no
 * allow, and reads it as PREFERRED), and other spellings a string may use
 */
export const sslModeNames: { mode: SslMode; postgres: string; mysql?: [label: string, value: string]; also?: string[] }[] = [
    { mode: 'disable', postgres: 'Disable', mysql: ['Disabled', 'DISABLED'], also: ['false', '0'] },
    { mode: 'allow', postgres: 'Allow' },
    { mode: 'prefer', postgres: 'Prefer', mysql: ['Preferred', 'PREFERRED'] },
    { mode: 'require', postgres: 'Require', mysql: ['Required', 'REQUIRED'], also: ['true', '1'] },
    { mode: 'verify-ca', postgres: 'Verify CA', mysql: ['Verify CA', 'VERIFY_CA'] },
    { mode: 'verify-full', postgres: 'Verify full', mysql: ['Verify identity', 'VERIFY_IDENTITY'], also: ['verify-identity'] },
];

const sslModes = new Map<string, SslMode>(
    sslModeNames.flatMap(({ mode, mysql, also = [] }) => [mode, ...(mysql ? [mysql[1].toLowerCase()] : []), ...also].map((name) => [name, mode])),
);

function sslModeOf(value: string): SslMode {
    const mode = sslModes.get(value.toLowerCase());
    if (!mode) throw new Error(`SSL mode “${value}” isn’t one QluePrint knows. Use disable, prefer, require, verify-ca or verify-full.`);
    return mode;
}

// ADO.NET's Authentication= values, and go-mssqldb's fedauth=, without spaces
const authKinds = new Map<string, MssqlAuthKind>([
    ['sqlpassword', 'sql_login'],
    ['activedirectoryinteractive', 'entra_interactive'],
    // DefaultAzureCredential's sign-in on a desktop is the Azure CLI's
    ['activedirectorydefault', 'azure_cli'],
    ['activedirectoryazcli', 'azure_cli'],
    ['activedirectorymanagedidentity', 'managed_identity'],
    ['activedirectorymsi', 'managed_identity'],
    ['activedirectorypassword', 'entra_password'],
]);

const authNames: Record<MssqlAuthKind, string | null> = {
    sql_login: null,
    entra_interactive: 'Active Directory Interactive',
    azure_cli: 'Active Directory Default',
    managed_identity: 'Active Directory Managed Identity',
    entra_password: 'Active Directory Password',
};

function authOf(value: string): MssqlAuthKind {
    const kind = authKinds.get(value.toLowerCase().replace(/[\s_-]/g, ''));
    if (!kind)
        throw new Error(
            `Authentication “${value}” isn’t supported. Use Active Directory Interactive, Default, Managed Identity or Password, or a SQL login.`,
        );
    return kind;
}

const yes = (value: string) => /^(true|yes|1|mandatory|strict)$/i.test(value);

/** SQL Server's own keys, shared by its ADO.NET, JDBC and URL forms; false if `key` isn't one */
function mssqlKey(parsed: Parsed, key: string, value: string): boolean {
    if (key === 'encrypt') parsed.encrypt = yes(value);
    else if (key === 'trustservercertificate' || key === 'trust server certificate') parsed.trustServerCertificate = yes(value);
    else if (key === 'authentication' || key === 'fedauth') parsed.auth = authOf(value);
    else if (key === 'instancename' || key === 'instance name') parsed.instance = value;
    else if (key === 'database' || key === 'initial catalog' || key === 'databasename') parsed.database = value;
    else return false;
    return true;
}

/** `host\instance` plus a port after `separator` (ADO.NET's comma, JDBC's colon); `.` and `(local)` are this machine */
function setServer(parsed: Parsed, value: string, separator: ',' | ':') {
    const server = value.replace(/^tcp:/i, '').trim();
    const at = server.lastIndexOf(separator);
    if (at >= 0) parsed.port = parsePort(server.slice(at + 1).trim());
    const [host, instance] = (at >= 0 ? server.slice(0, at) : server).split('\\');
    parsed.host = /^(\.|\(local\))$/i.test(host.trim()) ? 'localhost' : host.trim();
    if (instance?.trim()) parsed.instance = instance.trim();
}

/** A managed identity's User Id is its client ID; the Azure CLI signs in as whoever ran az login */
function mssqlLogin(parsed: Parsed): Parsed {
    if (parsed.auth === 'managed_identity') return { ...parsed, user: undefined, clientId: parsed.user };
    if (parsed.auth === 'azure_cli') return { ...parsed, user: undefined };
    return parsed;
}

const fail = (error: string): ParseResult => ({ ok: false, error });

function decode(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        throw new Error(`“${text}” has a broken %-escape.`);
    }
}

function parsePort(text: string): number {
    const port = Number(text);
    if (!/^\d+$/.test(text) || port < 1 || port > 65535) throw new Error(`Port “${text}” isn’t a number from 1 to 65535.`);
    return port;
}

/** Fills the server defaults and drops empty values */
function finish(parsed: Parsed): ParseResult {
    const value: Parsed = { engine: parsed.engine };
    for (const [key, v] of Object.entries(parsed)) if (v !== undefined && v !== '') Object.assign(value, { [key]: v });
    if (value.engine !== 'sqlite') {
        value.host ??= 'localhost';
        value.port ??= defaultPort[value.engine];
    } else if (!value.path) return fail('The string has no database file path.');
    return { ok: true, value };
}

function parseSqlite(rest: string): ParseResult {
    // sqlite:///abs, sqlite://rel, sqlite:rel; the query (?mode=ro) is driver options
    let path = rest.replace(/[?#].*$/, '');
    if (path.startsWith('//')) path = path.slice(2);
    path = decode(path);
    // sqlite:///C:/data.db is a Windows path, not /C:/data.db
    if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
    if (path === ':memory:' || path === '')
        return fail(path ? 'In-memory databases can’t be saved. Use a database file.' : 'The string has no database file path.');
    return finish({ engine: 'sqlite', path });
}

function parseUrl(engine: StringEngine, rest: string): ParseResult {
    if (!rest.startsWith('//')) return fail('Expected “//” after the scheme, as in postgres://user@host/database.');
    let body = rest.slice(2);
    let query = '';
    body = body.replace(/#.*$/, '');
    const q = body.indexOf('?');
    if (q >= 0) [body, query] = [body.slice(0, q), body.slice(q + 1)];
    const slash = body.indexOf('/');
    const authority = slash >= 0 ? body.slice(0, slash) : body;
    const database = slash >= 0 ? decode(body.slice(slash + 1)) : undefined;

    // The last @ splits the login from the host: an unescaped @ in a password still works
    const at = authority.lastIndexOf('@');
    const login = at >= 0 ? authority.slice(0, at) : '';
    const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
    const colon = login.indexOf(':');
    const user = decode(colon >= 0 ? login.slice(0, colon) : login);
    const password = colon >= 0 ? decode(login.slice(colon + 1)) : undefined;

    let host: string | undefined;
    let port: number | undefined;
    if (hostPort.includes(',')) return fail('Several hosts aren’t supported. Keep one host in the string.');
    if (hostPort.startsWith('[')) {
        const end = hostPort.indexOf(']');
        if (end < 0) return fail('An IPv6 host is missing its closing “]”.');
        host = hostPort.slice(1, end);
        const after = hostPort.slice(end + 1);
        if (after && !after.startsWith(':')) return fail(`Unexpected “${after}” after the IPv6 host.`);
        if (after.length > 1) port = parsePort(after.slice(1));
    } else {
        const c = hostPort.lastIndexOf(':');
        host = decode(c >= 0 ? hostPort.slice(0, c) : hostPort);
        if (c >= 0 && c < hostPort.length - 1) port = parsePort(hostPort.slice(c + 1));
    }

    // go-mssqldb's sqlserver://host/instance?database=…: the path is the instance
    const mssql = engine === 'mssql';
    const parsed: Parsed = mssql ? { engine, host, port, user, password, instance: database } : { engine, host, port, user, password, database };
    // sslmode wins over ssl, and the first ssl over later ones
    let sslSet = false;
    for (const pair of query.split('&')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        const key = decode((eq >= 0 ? pair.slice(0, eq) : pair).replace(/\+/g, ' ')).toLowerCase();
        const value = eq >= 0 ? decode(pair.slice(eq + 1).replace(/\+/g, ' ')) : '';
        if (mssql && mssqlKey(parsed, key, value)) continue;
        if (key === 'sslmode' || key === 'ssl-mode' || key === 'ssl_mode') {
            sslSet = true;
            parsed.sslMode = sslModeOf(value);
        } else if (key === 'ssl' && !sslSet) {
            sslSet = true;
            parsed.sslMode = sslModeOf(value || 'true');
        } else if (key === 'sslrootcert' || key === 'ssl-ca' || key === 'sslca') parsed.sslCa = value;
        else if (key === 'host') host = parsed.host = value;
        else if (key === 'port') parsed.port = parsePort(value);
        else if (key === 'user') parsed.user = value;
        else if (key === 'password') parsed.password = value;
        else if (key === 'dbname') parsed.database = value;
    }
    if (host?.startsWith('/')) return fail('Unix socket hosts aren’t supported. Use a host name or IP address.');
    return finish(mssql ? mssqlLogin(parsed) : parsed);
}

const libpqKeys = new Map<string, 'host' | 'port' | 'database' | 'user' | 'password' | 'sslMode' | 'sslCa'>([
    ['host', 'host'],
    ['hostaddr', 'host'],
    ['port', 'port'],
    ['dbname', 'database'],
    ['user', 'user'],
    ['password', 'password'],
    ['sslmode', 'sslMode'],
    ['sslrootcert', 'sslCa'],
]);

/** Postgres' libpq form: host=… port=… dbname=…, values optionally 'quoted' with \' and \\ escapes */
function parseKeyValue(text: string): ParseResult {
    const parsed: Parsed = { engine: 'postgres' };
    const pair = /\s*([A-Za-z_]+)\s*=\s*('((?:[^'\\]|\\.)*)'|(?!')(\S*))/y;
    let known = 0;
    while (pair.lastIndex < text.length && text.slice(pair.lastIndex).trim()) {
        const start = pair.lastIndex;
        const m = pair.exec(text);
        if (!m) return fail(`Couldn’t read “${text.slice(start).trim()}”. Expected key=value pairs.`);
        const value = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : m[4];
        const field = libpqKeys.get(m[1].toLowerCase());
        if (!field) continue;
        known++;
        if (field === 'port') parsed.port = parsePort(value);
        else if (field === 'sslMode') parsed.sslMode = sslModeOf(value);
        else parsed[field] = value;
    }
    if (!known) return fail('No connection settings found. Expected host=… dbname=… user=…');
    if (parsed.host?.includes(',')) return fail('Several hosts aren’t supported. Keep one host in the string.');
    return finish(parsed);
}

/** SQL Server's ADO.NET form (Server=host,port;Database=…;User Id=…;Authentication=…), or JDBC's properties after `base` */
function parseAdo(text: string, base: Parsed = { engine: 'mssql' }): ParseResult {
    const parsed: Parsed = { ...base };
    // Values may be "double" or 'single' quoted (JDBC: {braced}), with the quote doubled inside
    const pair = /\s*([^=;]+?)\s*=\s*("((?:[^"]|"")*)"|'((?:[^']|'')*)'|\{((?:[^}]|\}\})*)\}|([^;]*))\s*(?:;|$)/y;
    while (pair.lastIndex < text.length && text.slice(pair.lastIndex).replace(/;/g, '').trim()) {
        const start = pair.lastIndex;
        const m = pair.exec(text);
        if (!m) return fail(`Couldn’t read “${text.slice(start).trim()}”. Expected Key=Value; pairs.`);
        const key = m[1].toLowerCase().replace(/\s+/g, ' ');
        const value = m[3]?.replace(/""/g, '"') ?? m[4]?.replace(/''/g, "'") ?? m[5]?.replace(/\}\}/g, '}') ?? m[6].trim();
        if (['server', 'data source', 'address', 'addr', 'network address', 'servername'].includes(key)) setServer(parsed, value, ',');
        else if (key === 'portnumber' || key === 'port') parsed.port = parsePort(value);
        else if (['user id', 'uid', 'user', 'username'].includes(key)) parsed.user = value;
        else if (key === 'password' || key === 'pwd') parsed.password = value;
        else mssqlKey(parsed, key, value);
    }
    if (!parsed.host) return fail('The string has no Server=… part.');
    return finish(mssqlLogin(parsed));
}

/** JDBC's sqlserver://host\instance:port;databaseName=…;encrypt=true (jdbc: already removed) */
function parseJdbc(rest: string): ParseResult {
    if (!rest.startsWith('//')) return fail('Expected “//” after the scheme, as in sqlserver://host:1433;databaseName=shop.');
    const semi = rest.indexOf(';');
    const parsed: Parsed = { engine: 'mssql' };
    setServer(parsed, rest.slice(2, semi), ':');
    return parseAdo(rest.slice(semi + 1), parsed);
}

/** Reads any supported connection string; the error says what to fix */
export function parseConnectionString(input: string): ParseResult {
    const text = input.trim();
    if (!text) return fail('Paste a connection string, such as postgres://user@localhost:5432/shop.');
    try {
        // jdbc:postgresql://…, jdbc:sqlserver://…: the rest is the driver's own form
        const unwrapped = text.replace(/^jdbc:/i, '');
        const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(unwrapped);
        const engine = scheme && schemes.get(scheme[1].toLowerCase());
        const rest = scheme ? unwrapped.slice(scheme[0].length) : '';
        if (engine === 'sqlite') return parseSqlite(rest);
        if (engine === 'mssql' && rest.includes(';')) return parseJdbc(rest);
        if (engine) return parseUrl(engine, rest);
        if (scheme && text.startsWith(`${scheme[1]}://`)) return fail(`“${scheme[1]}” connection strings aren’t supported.`);
        if (/^\s*(server|data source|address|addr|network address)\s*=/i.test(text)) return parseAdo(text);
        if (text.includes('=')) return text.includes(';') ? parseAdo(text) : parseKeyValue(text);
        return fail(
            'Not a connection string. Start with postgres://, mysql://, mariadb://, sqlserver:// or sqlite:, or use host=… dbname=… or Server=…; pairs.',
        );
    } catch (error) {
        return fail((error as Error).message);
    }
}

/** What `toConnectionString` writes: the dialog's settings */
type StringSettings = {
    host: string;
    port: number | string;
    user: string;
    database: string;
    path: string;
    sslMode?: SslMode;
    instance?: string;
    auth?: MssqlAuthKind;
    encrypt?: boolean;
    trustServerCertificate?: boolean;
    clientId?: string;
};

/** A SQL Server's name: `host`, or `host\instance` for a named instance */
export function serverName(host: string, instance?: string): string {
    const named = instance?.trim();
    return named ? `${host.trim()}\\${named}` : host.trim();
}

/** An ADO.NET value, "quoted" when it would otherwise end early or lose spaces */
const adoValue = (value: string) => (/[;"'=]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** A URL (SQL Server: ADO.NET) for the settings, without the password (it stays in its own field) */
export function toConnectionString(engine: StringEngine, settings: StringSettings): string {
    const { host, port, user, database, path, sslMode } = settings;
    if (engine === 'sqlite') {
        // encodeURI leaves ? and # alone, which would end the path early
        const encoded = encodeURI(path).replace(/[?#]/g, encodeURIComponent);
        return path.startsWith('/') ? `sqlite://${encoded}` : `sqlite:${encoded}`;
    }
    if (engine === 'mssql') {
        const auth = settings.auth ?? 'sql_login';
        const parts = [`Server=tcp:${serverName(host, settings.instance)}${port ? `,${port}` : ''}`];
        if (database) parts.push(`Database=${adoValue(database)}`);
        const login = auth === 'managed_identity' ? settings.clientId : auth === 'azure_cli' ? '' : user;
        if (login) parts.push(`User Id=${adoValue(login)}`);
        if (authNames[auth]) parts.push(`Authentication=${authNames[auth]}`);
        parts.push(`Encrypt=${settings.encrypt ? 'True' : 'False'}`, `TrustServerCertificate=${settings.trustServerCertificate ? 'True' : 'False'}`);
        return `${parts.join(';')};`;
    }
    const at = user ? `${encodeURIComponent(user)}@` : '';
    const name = host.includes(':') ? `[${host}]` : host;
    const db = database ? `/${encodeURIComponent(database)}` : '';
    const mysqlMode = sslModeNames.find((n) => n.mode === sslMode)?.mysql?.[1] ?? 'PREFERRED';
    const ssl = !sslMode || sslMode === 'prefer' ? '' : engine === 'postgres' ? `?sslmode=${sslMode}` : `?ssl-mode=${mysqlMode}`;
    return `${engine}://${at}${name}${port ? `:${port}` : ''}${db}${ssl}`;
}
