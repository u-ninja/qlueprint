import { useRef, useState, type ClipboardEvent, type ComponentProps, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CircleAlertIcon, LoaderCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Facts } from '@/components/local/StepFrame';
import { commands, type ConnectRequest, type Engine, type MssqlAuth, type SavedConnection, type SslMode } from '@/bindings';
import { errorMessage, useConnections } from '@/stores/connections';
import { connectEngine, connectEngines, engineName, type ConnectEngine } from '@/lib/engines';
import {
    parseConnectionString,
    serverName,
    sslModeNames,
    toConnectionString,
    type MssqlAuthKind,
    type Parsed,
    type SslMode as StringSslMode,
    type StringEngine,
} from '@/lib/connection-string';
import { Enter } from '@/lib/spring';
import { cn } from '@/lib/utils';
import { EngineLogo } from './engine-logos';

/** The form's values, as typed; `port` stays text until the request is built */
type Values = {
    host: string;
    port: string;
    user: string;
    password: string;
    database: string;
    path: string;
    showAll: boolean;
    /** Postgres and MySQL */
    sslMode: SslMode;
    sslCa: string;
    /** SQL Server. `user` is the SQL login, the Entra account, or the account that signed in */
    instance: string;
    auth: MssqlAuth;
    /** null: follow the host (on for Azure SQL) until it's set */
    encrypt: boolean | null;
    trustServerCertificate: boolean;
    tenantId: string;
    /** The app's client ID, or a user-assigned managed identity's */
    clientId: string;
};

const AZURE_SQL = /\.(database\.windows\.net|database\.chinacloudapi\.cn|database\.usgovcloudapi\.net|fabric\.microsoft\.com)$/i;
const encrypts = (v: Values) => v.encrypt ?? AZURE_SQL.test(v.host.trim());

type AuthMethod = { id: MssqlAuth; label: string; hint?: string; user?: string; password?: boolean; warn?: boolean };

const authMethods: AuthMethod[] = [
    { id: 'sql_login', label: 'SQL Server login', user: 'User', password: true },
    { id: 'entra_interactive', label: 'Microsoft Entra MFA', hint: 'Signs in through your browser, with MFA when your organization asks for it.' },
    { id: 'azure_cli', label: 'Azure CLI', hint: 'Signs in as the account you used with “az login”.' },
    {
        id: 'managed_identity',
        label: 'Managed identity',
        hint: 'Signs in as the identity of the Azure VM or App Service QluePrint runs on. A user-assigned one goes under Advanced.',
    },
    {
        id: 'entra_password',
        label: 'Microsoft Entra password (deprecated)',
        hint: 'Deprecated by Microsoft, and fails on accounts that require MFA. Prefer Microsoft Entra MFA.',
        user: 'Account',
        password: true,
        warn: true,
    },
];
const authMethod = (id: MssqlAuth) => authMethods.find((m) => m.id === id) ?? authMethods[0];

/** Each engine's names for the TLS modes, in order; MySQL has no "allow" */
const sslModes: Record<'postgres' | 'mysql', [SslMode, string][]> = {
    postgres: sslModeNames.map(({ mode, postgres }) => [mode, postgres]),
    mysql: sslModeNames.flatMap(({ mode, mysql }) => (mysql ? [[mode, mysql[0]]] : [])),
};

// connection-string.ts declares its types by hand to stay free of `@/` imports: they must match the bindings
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
void ([true, true, true] satisfies [Same<StringSslMode, SslMode>, Same<MssqlAuthKind, MssqlAuth>, Same<StringEngine, Engine>]);

const sslHints: Record<SslMode, string> = {
    disable: 'No TLS: traffic isn’t encrypted.',
    allow: 'TLS only when the server insists on it.',
    prefer: 'TLS when the server offers it. The certificate isn’t checked.',
    require: 'Always TLS. The certificate isn’t checked.',
    'verify-ca': 'Always TLS, with a certificate from a trusted CA.',
    'verify-full': 'Always TLS, with a trusted certificate that names this host.',
};

const LAST_ENGINE = 'qc-last-connect-engine';

function lastEngine(): Engine {
    try {
        const id = localStorage.getItem(LAST_ENGINE);
        return connectEngines.find((e) => e.id === id)?.id ?? 'postgres';
    } catch {
        return 'postgres';
    }
}

function defaults(engine: ConnectEngine): Values {
    return {
        host: 'localhost',
        port: String(engine.port ?? ''),
        user: engine.user,
        password: '',
        database: '',
        path: '',
        showAll: false,
        sslMode: 'prefer',
        sslCa: '',
        instance: '',
        auth: 'sql_login',
        encrypt: null,
        trustServerCertificate: false,
        tenantId: '',
        clientId: '',
    };
}

function editValues(edit: SavedConnection): Values {
    const { config } = edit;
    const base = defaults(connectEngine(config.kind));
    if (config.kind === 'sqlite') return { ...base, path: config.path };
    const { host, port, user, database, showAllDatabases } = config;
    const server = { ...base, host, port: String(port), user, database, showAll: showAllDatabases ?? false };
    if (config.kind !== 'mssql') return { ...server, sslMode: config.sslMode ?? 'prefer', sslCa: config.sslCa ?? '' };
    const { instance, auth, encrypt, trustServerCertificate, tenantId, clientId } = config;
    return { ...server, instance: instance ?? '', auth, encrypt, trustServerCertificate, tenantId: tenantId ?? '', clientId: clientId ?? '' };
}

function requestOf(engine: ConnectEngine, v: Values): ConnectRequest {
    if (engine.kind === 'sqlite') return { kind: 'sqlite', path: v.path.trim() };
    const server = { host: v.host.trim(), port: Number(v.port), database: v.database.trim(), showAllDatabases: v.showAll };
    if (engine.kind !== 'mssql')
        return { kind: engine.kind, ...server, user: v.user.trim(), password: v.password, sslMode: v.sslMode, sslCa: v.sslCa.trim() };
    const method = authMethod(v.auth);
    return {
        kind: 'mssql',
        ...server,
        instance: v.instance.trim(),
        // Interactive sign-in keeps the account that signed in; the Azure CLI and managed identity have none
        user: method.user || v.auth === 'entra_interactive' ? v.user.trim() : '',
        password: method.password ? v.password : '',
        auth: v.auth,
        encrypt: encrypts(v),
        trustServerCertificate: v.trustServerCertificate,
        tenantId: v.tenantId.trim(),
        clientId: v.clientId.trim(),
    };
}

/** `<database> on <host>`, the file name for SQLite; the port only when it isn't the usual one */
function defaultName(engine: ConnectEngine, v: Values) {
    if (engine.kind === 'sqlite') return v.path.split(/[\\/]/).pop() ?? '';
    const host = serverName(v.host.trim() || 'localhost', engine.kind === 'mssql' ? v.instance : '');
    const where = v.port && Number(v.port) !== engine.port ? `${host}:${v.port}` : host;
    return `${v.database.trim() || engineName[engine.id]} on ${where}`;
}

/** The parsed string's engine, or why it can't be used here (an edit keeps its driver: the saved password belongs to it) */
function engineFor(parsed: Parsed, current: ConnectEngine, fixed: boolean): Engine | { error: string } {
    const kind = connectEngine(parsed.engine).kind;
    // mysql:// is fine for MariaDB and the other way round: same driver
    if (kind === current.kind) return current.id;
    if (fixed) return { error: `This connection is ${engineName[current.id]}; the string is for ${engineName[parsed.engine]}.` };
    return parsed.engine;
}

function fromParsed(p: Parsed, prev: Values): Values {
    // The generated string leaves the password out, so a string without one keeps the typed one. No
    // string names a tenant or the app's client ID, so those stay too
    return {
        ...prev,
        host: p.host ?? '',
        port: String(p.port ?? ''),
        user: p.user ?? '',
        database: p.database ?? '',
        path: p.path ?? '',
        password: p.password ?? prev.password,
        sslMode: p.sslMode ?? 'prefer',
        sslCa: p.sslCa ?? '',
        instance: p.instance ?? '',
        auth: p.auth ?? 'sql_login',
        encrypt: p.encrypt ?? null,
        trustServerCertificate: p.trustServerCertificate ?? false,
        clientId: p.clientId ?? prev.clientId,
    };
}

function Field({ label, name, ...props }: { label: string; name: string } & ComponentProps<typeof Input>) {
    const id = `connect-${name}`;
    return (
        <div className="grid min-w-0 gap-1.5">
            <Label htmlFor={id}>{label}</Label>
            <Input id={id} name={name} autoComplete="off" spellCheck={false} {...props} />
        </div>
    );
}

/** Free text until "Browse" loads the server's databases with the fields above, then a list to pick from */
function DatabaseField({
    value,
    onChange,
    placeholder,
    request,
}: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    request: () => ConnectRequest;
}) {
    const [databases, setDatabases] = useState<string[] | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    async function browse() {
        setError('');
        setLoading(true);
        try {
            const found = await commands.listDatabases(request());
            if (found.length) setDatabases(found);
            else setError('No databases found on this server.');
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="grid gap-1.5">
            <Label htmlFor="connect-database">Database</Label>
            <div className="flex gap-2">
                {databases ? (
                    <Select value={value || undefined} onValueChange={onChange}>
                        <SelectTrigger id="connect-database" className="min-w-0 flex-1">
                            <SelectValue placeholder={placeholder} />
                        </SelectTrigger>
                        <SelectContent position="popper">
                            {databases.map((name) => (
                                <SelectItem key={name} value={name}>
                                    {name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                ) : (
                    <Input
                        id="connect-database"
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        placeholder={placeholder}
                        autoComplete="off"
                        spellCheck={false}
                        className="min-w-0 flex-1"
                    />
                )}
                <Button type="button" variant="outline" onClick={browse} disabled={loading}>
                    {loading ? 'Loading…' : 'Browse'}
                </Button>
            </div>
            {error && (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            )}
        </div>
    );
}

// Matches the tiles' grid-cols-2, for Up/Down
const COLUMNS = 2;

/** Arrow keys move between the tiles; Tab and Enter work as for any button */
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[event.key];
    if (!delta) return;
    const tiles = [...event.currentTarget.querySelectorAll('button')];
    const next = tiles[tiles.indexOf(document.activeElement as HTMLButtonElement) + delta];
    if (!next) return;
    event.preventDefault();
    next.focus();
}

function PickEngine({ selected, onPick }: { selected: Engine; onPick: (id: Engine) => void }) {
    return (
        <Enter x={-16} className="grid gap-4">
            <DialogHeader>
                <DialogTitle>Connect to a database</DialogTitle>
                <DialogDescription>Pick the type of database to connect to.</DialogDescription>
            </DialogHeader>
            <div role="group" aria-label="Database type" className="grid grid-cols-2 gap-2" onKeyDown={moveFocus}>
                {connectEngines.map((e) => (
                    <button
                        key={e.id}
                        type="button"
                        autoFocus={e.id === selected}
                        onClick={() => onPick(e.id)}
                        className="flex items-center gap-3 rounded-lg border border-border-soft px-3 py-3 text-left transition-colors hover:border-border hover:bg-hover focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                        <EngineLogo id={e.id} className="size-7 flex-none" />
                        <span className="min-w-0">
                            <span className="block font-medium">{engineName[e.id]}</span>
                            <span className="block font-mono text-[11px] text-fg4">{e.port ? `port ${e.port}` : 'file'}</span>
                        </span>
                    </button>
                ))}
            </div>
        </Enter>
    );
}

type Test = 'testing' | { ok: true } | { error: string } | null;

const notSet = <span className="text-fg3">Not set</span>;

/** What a valid string was read as, so a typo shows before connecting */
function Understood({ parsed, password }: { parsed: Parsed; password: string }) {
    if (parsed.engine === 'sqlite')
        return (
            <div className="font-mono text-xs">
                <Facts rows={[['File', parsed.path]]} />
            </div>
        );
    const mssql = parsed.engine === 'mssql';
    const method = authMethod(parsed.auth ?? 'sql_login');
    const rows: [string, ReactNode][] = [
        ['Host', parsed.host],
        ['Port', parsed.port],
        ...(parsed.instance ? [['Instance', parsed.instance] as [string, ReactNode]] : []),
        ['Database', parsed.database ?? notSet],
    ];
    if (mssql) rows.push(['Sign-in', method.label]);
    if (!mssql || method.user || parsed.auth === 'entra_interactive') rows.push(['User', parsed.user ?? notSet]);
    if (!mssql || method.password) rows.push(['Password', parsed.password ? '••• (from the string)' : password ? '••• (from Fields)' : notSet]);
    if (parsed.clientId) rows.push(['Identity', parsed.clientId]);
    if (parsed.sslMode) {
        const names = sslModes[parsed.engine === 'postgres' ? 'postgres' : 'mysql'];
        rows.push(['SSL', names.find(([mode]) => mode === parsed.sslMode)?.[1] ?? parsed.sslMode]);
    }
    if (parsed.sslCa) rows.push(['CA file', parsed.sslCa]);
    if (parsed.encrypt !== undefined) rows.push(['Encrypt', parsed.encrypt ? 'Yes' : 'No']);
    if (parsed.trustServerCertificate !== undefined) rows.push(['Trust certificate', parsed.trustServerCertificate ? 'Yes' : 'No']);
    return (
        <div className="font-mono text-xs">
            <Facts rows={rows} />
        </div>
    );
}

/** A settings row: label and description on the left, a switch on the right */
function SwitchRow({
    id,
    label,
    description,
    ...props
}: { id: string; label: string; description: ReactNode } & Pick<ComponentProps<typeof Switch>, 'checked' | 'onCheckedChange' | 'disabled'>) {
    return (
        <div className="flex items-center justify-between gap-3">
            <Label htmlFor={id} className="flex flex-col items-start gap-0.5 font-normal">
                {label}
                <span className="text-xs text-fg3">{description}</span>
            </Label>
            <Switch id={id} {...props} />
        </div>
    );
}

/** Postgres and MySQL: the TLS mode, and a CA file for the modes that check the certificate */
function SslFields({ kind, values, change }: { kind: 'postgres' | 'mysql'; values: Values; change: (patch: Partial<Values>) => void }) {
    // MySQL has no "allow": it reads as preferred
    const mode = kind === 'mysql' && values.sslMode === 'allow' ? 'prefer' : values.sslMode;
    return (
        <>
            <div className="grid gap-1.5">
                <Label htmlFor="connect-ssl">SSL</Label>
                <Select value={mode} onValueChange={(sslMode) => change({ sslMode: sslMode as SslMode })}>
                    <SelectTrigger id="connect-ssl" aria-describedby="connect-ssl-hint" className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                        {sslModes[kind].map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                                {label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <p id="connect-ssl-hint" className="text-xs text-fg3">
                    {sslHints[mode]}
                </p>
            </div>
            {mode.startsWith('verify') && (
                <Field
                    label="CA certificate"
                    name="ssl-ca"
                    value={values.sslCa}
                    onChange={(e) => change({ sslCa: e.target.value })}
                    placeholder="Bundled public CAs"
                    className="font-mono text-xs"
                />
            )}
        </>
    );
}

/** "Sign in with Microsoft": the browser sign-in runs in Rust, which keeps the token; only the account comes back */
function MicrosoftSignIn({ values, onSignedIn }: { values: Values; onSignedIn: (account: string) => void }) {
    const [state, setState] = useState<'idle' | 'waiting' | { error: string }>('idle');
    const cancelled = useRef(false);

    async function signIn() {
        cancelled.current = false;
        setState('waiting');
        try {
            onSignedIn(await commands.entraSignIn(values.tenantId.trim(), values.clientId.trim(), values.user.trim()));
            setState('idle');
        } catch (err) {
            setState(cancelled.current ? 'idle' : { error: errorMessage(err) });
        }
    }

    function cancel() {
        cancelled.current = true;
        void commands.entraCancelSignIn();
    }

    return (
        <div className="grid gap-1.5">
            <div className="flex min-h-8 items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm" title={values.user || undefined}>
                    {values.user ? (
                        <>
                            <span className="text-fg3">Signed in as </span>
                            {values.user}
                        </>
                    ) : (
                        <span className="text-fg3">Not signed in</span>
                    )}
                </p>
                {state === 'waiting' ? (
                    <Button type="button" variant="outline" onClick={cancel}>
                        Cancel sign-in
                    </Button>
                ) : (
                    <Button type="button" variant="outline" onClick={signIn}>
                        {values.user ? 'Switch account' : 'Sign in with Microsoft'}
                    </Button>
                )}
            </div>
            {state === 'waiting' && (
                <p role="status" className="flex items-center gap-2 text-sm text-fg3">
                    <LoaderCircleIcon className="size-4 flex-none animate-spin" aria-hidden />
                    Finish signing in in your browser…
                </p>
            )}
            {typeof state === 'object' && (
                <p role="alert" className="text-sm text-danger">
                    {state.error}
                </p>
            )}
        </div>
    );
}

/** SQL Server's sign-in: the method, then what it needs */
function MssqlLogin({ values, change, edit }: { values: Values; change: (patch: Partial<Values>) => void; edit?: SavedConnection }) {
    const method = authMethod(values.auth);
    // An empty password keeps the saved one only when it was saved for the same kind of sign-in
    const keeps = edit?.config.kind === 'mssql' && edit.config.auth === values.auth;
    return (
        <>
            <div className="grid gap-1.5">
                <Label htmlFor="connect-auth">Authentication</Label>
                <Select value={values.auth} onValueChange={(auth) => change({ auth: auth as MssqlAuth, password: '' })}>
                    <SelectTrigger id="connect-auth" aria-describedby={method.hint ? 'connect-auth-hint' : undefined} className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                        {authMethods.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                                {m.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {method.hint && (
                    <p id="connect-auth-hint" className={cn('text-xs', method.warn ? 'text-warning' : 'text-fg3')}>
                        {method.hint}
                    </p>
                )}
            </div>
            {method.user && (
                <div className="grid grid-cols-2 gap-2">
                    <Field label={method.user} name="user" value={values.user} onChange={(e) => change({ user: e.target.value })} required />
                    <Field
                        label="Password"
                        name="password"
                        type="password"
                        value={values.password}
                        onChange={(e) => change({ password: e.target.value })}
                        placeholder={keeps ? 'Unchanged' : undefined}
                    />
                </div>
            )}
            {values.auth === 'entra_interactive' && <MicrosoftSignIn values={values} onSignedIn={(user) => change({ user })} />}
        </>
    );
}

/** SQL Server's Advanced settings: encryption, and the Entra overrides its sign-in can use */
function MssqlAdvanced({ values, change }: { values: Values; change: (patch: Partial<Values>) => void }) {
    const encrypt = encrypts(values);
    const entra = values.auth === 'entra_interactive' || values.auth === 'entra_password';
    return (
        <>
            <SwitchRow
                id="connect-encrypt"
                label="Encrypt"
                description="Encrypt everything, not just the login. On for Azure SQL"
                checked={encrypt}
                onCheckedChange={(on) => change({ encrypt: on })}
            />
            <SwitchRow
                id="connect-trust"
                label="Trust server certificate"
                description={encrypt ? 'Accept any certificate, without checking who issued it' : 'Only used with Encrypt on'}
                checked={values.trustServerCertificate}
                onCheckedChange={(trustServerCertificate) => change({ trustServerCertificate })}
                disabled={!encrypt}
            />
            {encrypt && values.trustServerCertificate && (
                <p role="note" className="text-sm text-warning">
                    Anyone between you and the server could pose as it. Keep this for servers you run yourself.
                </p>
            )}
            {(entra || values.auth === 'azure_cli') && (
                <div className={cn('grid gap-2', entra && 'grid-cols-2')}>
                    <Field
                        label="Tenant ID"
                        name="tenant"
                        value={values.tenantId}
                        onChange={(e) => change({ tenantId: e.target.value })}
                        placeholder={values.auth === 'entra_interactive' ? 'From the server' : entra ? 'organizations' : 'The CLI’s default'}
                        className="font-mono text-xs"
                    />
                    {entra && (
                        <Field
                            label="Client ID"
                            name="client"
                            value={values.clientId}
                            onChange={(e) => change({ clientId: e.target.value })}
                            placeholder="SQL Server driver’s"
                            className="font-mono text-xs"
                        />
                    )}
                </div>
            )}
            {entra && (
                <p className="text-xs text-fg3">
                    {values.auth === 'entra_interactive' && 'Leave Tenant ID empty to use the tenant the server trusts, as for a guest account. '}
                    Signs in as Microsoft’s SQL Server driver app, which every organization already trusts. To sign in as your own app registration,
                    enter its client ID.
                </p>
            )}
            {values.auth === 'managed_identity' && (
                <Field
                    label="Managed identity client ID"
                    name="client"
                    value={values.clientId}
                    onChange={(e) => change({ clientId: e.target.value })}
                    placeholder="System-assigned"
                    className="font-mono text-xs"
                />
            )}
        </>
    );
}

function ConnectForm({ initial, edit, onBack, onDone }: { initial: Engine; edit?: SavedConnection; onBack?: () => void; onDone: () => void }) {
    const connect = useConnections((s) => s.connect);
    const update = useConnections((s) => s.update);
    const [engineId, setEngineId] = useState(initial);
    const engine = connectEngine(engineId);
    const [values, setValues] = useState(() => (edit ? editValues(edit) : defaults(engine)));
    // The name follows the settings until the user types one
    const [ownName, setOwnName] = useState<string | null>(edit?.label ?? null);
    const name = ownName ?? defaultName(engine, values);
    const [mode, setMode] = useState<'fields' | 'string'>('fields');
    const [text, setText] = useState('');
    const [notice, setNotice] = useState('');
    const [test, setTest] = useState<Test>(null);
    const [pending, setPending] = useState(false);
    const server = engine.kind !== 'sqlite';
    const mssql = engine.kind === 'mssql';

    const parsed = mode === 'string' ? parseConnectionString(text) : null;
    const target = parsed?.ok ? engineFor(parsed.value, engine, !!edit) : null;
    const stringError = parsed && (!parsed.ok ? parsed.error : typeof target === 'object' && target ? target.error : '');

    function change(patch: Partial<Values>) {
        setValues((v) => ({ ...v, ...patch }));
        setTest(null);
        setNotice('');
    }

    /** Fills every field from a connection string; false if it isn't one this dialog can use */
    function apply(input: string): boolean {
        const result = parseConnectionString(input);
        if (!result.ok) return false;
        const id = engineFor(result.value, engine, !!edit);
        if (typeof id === 'object') return false;
        setEngineId(id);
        setValues((v) => fromParsed(result.value, v));
        setTest(null);
        return true;
    }

    // Pasting a whole connection string into any field (but the password) fills them all
    function onPaste(event: ClipboardEvent<HTMLDivElement>) {
        if ((event.target as HTMLInputElement).type === 'password') return;
        const pasted = event.clipboardData.getData('text');
        if (!apply(pasted)) return;
        event.preventDefault();
        setNotice('Filled in from the pasted connection string.');
    }

    function switchMode(next: string) {
        if (next === 'string') setText(toConnectionString(engineId, { ...values, encrypt: encrypts(values) }));
        setMode(next as 'fields' | 'string');
        setNotice('');
    }

    async function runTest() {
        setTest('testing');
        try {
            await commands.testConnection(requestOf(engine, values), edit?.id ?? null);
            setTest({ ok: true });
        } catch (err) {
            setTest({ error: errorMessage(err) });
        }
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        // Submit stays enabled so a bad string is pointed at instead of leaving a dead button
        if (stringError) {
            document.getElementById('connect-string')?.focus();
            return;
        }
        // One status line: a failed Connect replaces a test's result instead of stacking under it
        setTest(null);
        setPending(true);
        try {
            const request = requestOf(engine, values);
            await (edit ? update(edit.id, request, name) : connect(request, name));
            try {
                localStorage.setItem(LAST_ENGINE, engineId);
            } catch {
                // Only a convenience: the next dialog starts on PostgreSQL instead
            }
            onDone();
        } catch (err) {
            setTest({ error: errorMessage(err) });
        } finally {
            setPending(false);
        }
    }

    return (
        <Enter x={edit ? 0 : 16} className="grid gap-4">
            <DialogHeader>
                <div className="flex items-center gap-2 pr-6">
                    {onBack && (
                        <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} className="-ml-1.5" aria-label="Back to database types">
                            <ChevronLeftIcon />
                        </Button>
                    )}
                    <EngineLogo id={engineId} className="size-5 flex-none" />
                    <DialogTitle className="truncate">{edit ? `Edit ${edit.label}` : `New ${engineName[engineId]} connection`}</DialogTitle>
                </div>
                <DialogDescription>
                    {edit
                        ? 'Saved once the new settings connect. Leave the password empty to keep the saved one.'
                        : 'Saved on this device. Passwords and sign-ins go into your system’s credential store.'}
                </DialogDescription>
            </DialogHeader>

            <form className="grid min-w-0 gap-4" onSubmit={onSubmit}>
                <Field label="Name" name="name" value={name} onChange={(e) => setOwnName(e.target.value)} required />

                <Tabs value={mode} onValueChange={switchMode} className="gap-3">
                    <TabsList className="w-full">
                        <TabsTrigger value="fields">Fields</TabsTrigger>
                        <TabsTrigger value="string">Connection string</TabsTrigger>
                    </TabsList>

                    <TabsContent value="fields" className="grid gap-3">
                        <div className="grid gap-3" onPaste={onPaste}>
                            {server ? (
                                <>
                                    <div className={cn('grid gap-2', mssql ? 'grid-cols-[1fr_7rem_5.5rem]' : 'grid-cols-[1fr_6rem]')}>
                                        <Field
                                            label="Host"
                                            name="host"
                                            value={values.host}
                                            onChange={(e) => change({ host: e.target.value })}
                                            required
                                        />
                                        {mssql && (
                                            <Field
                                                label="Instance"
                                                name="instance"
                                                value={values.instance}
                                                onChange={(e) => change({ instance: e.target.value })}
                                                placeholder="Default"
                                            />
                                        )}
                                        <Field
                                            label="Port"
                                            name="port"
                                            type="number"
                                            inputMode="numeric"
                                            min={1}
                                            max={65535}
                                            value={values.port}
                                            onChange={(e) => change({ port: e.target.value })}
                                            required
                                        />
                                    </div>
                                    {mssql ? (
                                        <MssqlLogin values={values} change={change} edit={edit} />
                                    ) : (
                                        <div className="grid grid-cols-2 gap-2">
                                            <Field
                                                label="User"
                                                name="user"
                                                value={values.user}
                                                onChange={(e) => change({ user: e.target.value })}
                                                required
                                            />
                                            <Field
                                                label="Password"
                                                name="password"
                                                type="password"
                                                value={values.password}
                                                onChange={(e) => change({ password: e.target.value })}
                                                placeholder={edit ? 'Unchanged' : undefined}
                                            />
                                        </div>
                                    )}
                                    <DatabaseField
                                        value={values.database}
                                        onChange={(database) => change({ database })}
                                        placeholder={engine.noDatabase}
                                        request={() => requestOf(engine, values)}
                                    />
                                </>
                            ) : (
                                // shortcut: typed path, add a native file picker (tauri-plugin-dialog) when another screen needs one too
                                <Field
                                    label="Database file"
                                    name="path"
                                    value={values.path}
                                    onChange={(e) => change({ path: e.target.value })}
                                    placeholder="/path/to/database.db"
                                    required
                                />
                            )}
                        </div>
                        {notice && (
                            <p role="status" className="text-sm text-fg3">
                                {notice}
                            </p>
                        )}
                        {server && (
                            <details className="group">
                                <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-fg2 select-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                                    <ChevronRightIcon className="size-3.5 transition-transform ease-spring group-open:rotate-90" aria-hidden />
                                    Advanced
                                </summary>
                                <div className="mt-3 grid gap-3">
                                    <SwitchRow
                                        id="connect-show-all"
                                        label="Show all databases"
                                        description="List every database on the server, not just this one"
                                        checked={values.showAll}
                                        onCheckedChange={(showAll) => change({ showAll })}
                                    />
                                    {mssql ? (
                                        <MssqlAdvanced values={values} change={change} />
                                    ) : (
                                        <SslFields kind={engine.kind === 'postgres' ? 'postgres' : 'mysql'} values={values} change={change} />
                                    )}
                                </div>
                            </details>
                        )}
                    </TabsContent>

                    <TabsContent value="string" className="grid gap-3">
                        <div className="grid gap-1.5">
                            <Label htmlFor="connect-string">Connection string</Label>
                            <textarea
                                id="connect-string"
                                value={text}
                                onChange={(e) => {
                                    setText(e.target.value);
                                    apply(e.target.value);
                                }}
                                rows={3}
                                placeholder={engine.example}
                                autoComplete="off"
                                spellCheck={false}
                                aria-invalid={!!stringError && !!text.trim()}
                                aria-describedby="connect-string-result"
                                className="w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs break-all transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30"
                            />
                        </div>
                        <div id="connect-string-result" aria-live="polite">
                            {stringError
                                ? text.trim() && <p className="text-sm text-danger">{stringError}</p>
                                : parsed?.ok && <Understood parsed={parsed.value} password={values.password} />}
                        </div>
                    </TabsContent>
                </Tabs>

                {test && (
                    <p role={typeof test === 'object' && 'error' in test ? 'alert' : 'status'} className="flex items-start gap-2 text-sm">
                        {test === 'testing' ? (
                            <>
                                <LoaderCircleIcon className="mt-0.5 size-4 flex-none animate-spin text-fg3" aria-hidden />
                                Testing…
                            </>
                        ) : 'ok' in test ? (
                            <>
                                <CheckIcon className="mt-0.5 size-4 flex-none text-success" aria-hidden />
                                Connected. Nothing was saved yet.
                            </>
                        ) : (
                            <>
                                <CircleAlertIcon className="mt-0.5 size-4 flex-none text-danger" aria-hidden />
                                <span className="min-w-0 text-danger [overflow-wrap:anywhere]">{test.error}</span>
                            </>
                        )}
                    </p>
                )}

                <div className="-mx-4 -mb-4 flex items-center gap-2 border-t border-border-soft px-4 py-3">
                    <Button type="button" variant="outline" onClick={runTest} disabled={test === 'testing' || !!stringError}>
                        Test connection
                    </Button>
                    <DialogClose asChild>
                        <Button type="button" variant="ghost" className="ml-auto">
                            Cancel
                        </Button>
                    </DialogClose>
                    <Button type="submit" disabled={pending}>
                        {pending ? 'Connecting…' : edit ? 'Save' : 'Connect'}
                    </Button>
                </div>
            </form>
        </Enter>
    );
}

type ConnectDialogProps =
    | { children: ReactNode; edit?: never; open?: never; onOpenChange?: never }
    /** Edits a saved connection in place; the caller opens it (e.g. from a context menu) */
    | { children?: never; edit: SavedConnection; open: boolean; onOpenChange: (open: boolean) => void };

/**
 * Wraps any trigger (children) so every "Connect" entry point opens the same dialog: pick a
 * database type, then name and set up the connection. With `edit`, the second step edits a
 * saved connection (its type stays: the saved password belongs to that server).
 */
export function ConnectDialog({ children, edit, ...controlled }: ConnectDialogProps) {
    const [ownOpen, setOwnOpen] = useState(false);
    const open = controlled.open ?? ownOpen;
    const setOpen = controlled.onOpenChange ?? setOwnOpen;
    // null: the type picker. The content unmounts on close, so each open starts over
    const [picked, setPicked] = useState<Engine | null>(null);
    const [selected, setSelected] = useState(lastEngine);

    function onOpenChange(next: boolean) {
        setOpen(next);
        if (next) setSelected(lastEngine());
        else setPicked(null);
    }

    function back() {
        setSelected(picked ?? selected);
        setPicked(null);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {children && <DialogTrigger asChild>{children}</DialogTrigger>}
            {/* The form is wide enough for a full Azure or Fabric host; picking an engine stays compact */}
            <DialogContent className={cn('max-h-[calc(100%-2rem)] overflow-y-auto', edit || picked ? 'sm:max-w-2xl' : 'sm:max-w-md')}>
                {edit ? (
                    <ConnectForm initial={edit.config.kind} edit={edit} onDone={() => onOpenChange(false)} />
                ) : picked ? (
                    <ConnectForm key={picked} initial={picked} onBack={back} onDone={() => onOpenChange(false)} />
                ) : (
                    <PickEngine selected={selected} onPick={setPicked} />
                )}
            </DialogContent>
        </Dialog>
    );
}
