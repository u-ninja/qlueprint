import { useState, type FormEvent, type ReactNode } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { RotateCw } from 'lucide-react';
import type { CommandError, Discovery, DockerStatus, LocalLogin, LocalTarget, Os, Provider, Template } from '@/bindings';
import { commands } from '@/bindings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusDot } from '@/components/shell/StatusDot';
import { errorMessage, type ConnectionState } from '@/stores/connections';
import { openConnection, useLocal } from '@/stores/local';
import { engineName } from '@/lib/engines';
import { cn } from '@/lib/utils';
import { StepFrame, mono } from './StepFrame';

const nativeManager: Record<Os, string> = { windows: 'winget', macos: 'Homebrew', linux: 'your package manager' };

const whyDocker =
    'Docker is the best way to run a local server: the same version on every machine, isolated from the rest of your system, and removed without leftovers.';

function DockerState({ status, discovering, onRetry }: { status: DockerStatus | null; discovering: boolean; onRetry: () => void }) {
    const retry = (
        <Button variant="outline" size="sm" onClick={onRetry} disabled={discovering}>
            <RotateCw aria-hidden className={cn(discovering && 'animate-spin')} /> {discovering ? 'Checking…' : 'Check again'}
        </Button>
    );
    if (!status) {
        return (
            <p role="status" className="text-fg3">
                Checking for Docker…
            </p>
        );
    }
    if (status.daemonRunning) {
        const meta = [status.platform, status.composeVersion && `Compose ${status.composeVersion}`].filter(Boolean).join(', ');
        return (
            <p className="flex items-center gap-2">
                <StatusDot state="open" />
                Docker {status.serverVersion} is running
                {meta && <span className="text-fg3">({meta})</span>}
            </p>
        );
    }
    const installName = status.os === 'linux' ? 'Docker Engine install guide' : 'Get Docker Desktop';
    const headline =
        status.problem === 'not_installed'
            ? 'Docker isn’t installed.'
            : status.problem === 'permission_denied'
              ? 'Docker refused this user.'
              : 'Docker is installed but not running. Start Docker Desktop (or the docker service), then check again.';
    return (
        <div className="flex flex-col gap-2 rounded-lg border border-border-soft bg-surface p-3">
            <p className="flex items-center gap-2 font-medium">
                <StatusDot state="failed" />
                {headline}
            </p>
            <p className="text-fg2">{whyDocker}</p>
            {status.detail && <p className={cn(mono, 'text-fg3 wrap-anywhere')}>{status.detail}</p>}
            <div className="flex gap-2">
                {status.problem === 'not_installed' && (
                    <Button size="sm" onClick={() => void openUrl(status.installUrl)}>
                        {installName}
                    </Button>
                )}
                {retry}
            </div>
        </div>
    );
}

function ProviderOption(props: {
    value: Provider;
    current: Provider;
    disabled?: boolean;
    title: string;
    detail: string;
    onChoose: (p: Provider) => void;
}) {
    const { value, current, disabled, title, detail, onChoose } = props;
    return (
        <button
            type="button"
            role="radio"
            aria-checked={current === value}
            disabled={disabled}
            onClick={() => onChoose(value)}
            className={cn(
                'flex flex-1 flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50',
                current === value ? 'border-primary bg-primary-soft' : 'border-border-soft hover:border-border hover:bg-hover',
            )}
        >
            <span className="font-medium">{title}</span>
            <span className="text-fg3">{detail}</span>
        </button>
    );
}

/** Credentials for a server whose password QueryCraft couldn't recover */
function LoginForm({ defaults, pending, onSubmit }: { defaults: LocalLogin; pending: boolean; onSubmit: (login: LocalLogin) => void }) {
    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const text = (name: string) => String(data.get(name) ?? '');
        onSubmit({ user: text('user'), password: text('password'), database: text('database') });
    }
    return (
        <form onSubmit={submit} className="mt-2 grid grid-cols-3 items-end gap-2">
            {(['user', 'password', 'database'] as const).map((name) => (
                <div key={name} className="grid gap-1">
                    <Label htmlFor={`existing-${name}`} className="text-xs font-normal text-fg3 capitalize">
                        {name}
                    </Label>
                    <Input
                        id={`existing-${name}`}
                        name={name}
                        type={name === 'password' ? 'password' : 'text'}
                        defaultValue={name === 'password' ? '' : defaults[name]}
                        autoComplete={name === 'password' ? 'current-password' : 'off'}
                        spellCheck={false}
                        required={name !== 'database'}
                        className="h-7"
                    />
                </div>
            ))}
            <Button type="submit" size="sm" disabled={pending} className="col-start-3 justify-self-end">
                {pending ? 'Connecting…' : 'Connect'}
            </Button>
        </form>
    );
}

/** A database server already on this machine, with the action that fits its state */
function Existing(props: {
    name: string;
    meta: string;
    state: ConnectionState;
    target: LocalTarget | null;
    login: LocalLogin;
    askFirst: boolean;
    action?: ReactNode;
    hint?: string;
}) {
    const { name, meta, state, target, login, askFirst, action, hint } = props;
    const setCreateOpen = useLocal((s) => s.setCreateOpen);
    const [asking, setAsking] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');

    async function connect(credentials: LocalLogin | null) {
        if (!target) return;
        setPending(true);
        setError('');
        try {
            await openConnection(await commands.connectLocalDatabase(target, credentials));
            setCreateOpen(false);
        } catch (err) {
            setError(errorMessage(err));
            if ((err as CommandError).code === 'invalid_credentials') setAsking(true);
        } finally {
            setPending(false);
        }
    }

    return (
        <li className="border-b border-border-soft py-2 last:border-b-0">
            <div className="flex items-center gap-2">
                <StatusDot state={state} />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className={cn(mono, 'flex-none text-fg3')}>{meta}</span>
                {action ??
                    (target && !asking && (
                        <Button variant="outline" size="xs" disabled={pending} onClick={() => (askFirst ? setAsking(true) : void connect(null))}>
                            {pending ? 'Connecting…' : 'Connect'}
                        </Button>
                    ))}
            </div>
            {hint && <p className="mt-1 pl-3.5 text-xs text-fg3">{hint}</p>}
            {asking && <LoginForm defaults={login} pending={pending} onSubmit={(l) => void connect(l)} />}
            {error && (
                <p role="alert" className="mt-1 pl-3.5 text-xs text-danger">
                    {error}
                </p>
            )}
        </li>
    );
}

function CopyCommand({ command }: { command: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <Button
            variant="outline"
            size="xs"
            title="Copy the command; QueryCraft only changes containers it created"
            onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true))}
        >
            {copied ? 'Copied' : `Copy “${command}”`}
        </Button>
    );
}

function OnThisMachine({ template, discovery, onChanged }: { template: Template; discovery: Discovery; onChanged: () => void }) {
    const lifecycle = useLocal((s) => s.lifecycle);
    const [starting, setStarting] = useState('');
    const containers = discovery.containers.filter((c) => c.engine === template.engine);
    const native = discovery.native.filter((n) => n.engine === template.engine);
    if (!containers.length && !native.length) return <p className="text-fg3">No {template.name} servers found on this machine.</p>;

    async function start(instanceId: string) {
        setStarting(instanceId);
        try {
            await lifecycle(instanceId, 'start');
            onChanged();
        } catch {
            // The error shows in Local servers; the row stays stopped here
        } finally {
            setStarting('');
        }
    }

    return (
        <ul>
            {containers.map((c) => {
                const running = c.state === 'running';
                const stoppedAction =
                    c.managed && c.instanceId ? (
                        <Button variant="outline" size="xs" disabled={starting === c.instanceId} onClick={() => void start(c.instanceId!)}>
                            {starting === c.instanceId ? 'Starting…' : 'Start'}
                        </Button>
                    ) : (
                        <CopyCommand command={`docker start ${c.name}`} />
                    );
                return (
                    <Existing
                        key={c.id}
                        name={c.name}
                        meta={[c.version, c.hostPort && `:${c.hostPort}`, c.managed ? 'QueryCraft' : 'container'].filter(Boolean).join(' ')}
                        state={!running ? 'closed' : c.health === 'unhealthy' ? 'failed' : 'open'}
                        target={running && c.hostPort ? { kind: 'container', id: c.id } : null}
                        login={{ user: c.user ?? '', password: '', database: c.database ?? '' }}
                        askFirst={!c.passwordKnown}
                        action={running ? undefined : stoppedAction}
                        hint={running && !c.hostPort ? 'Doesn’t publish its port to this machine, so QueryCraft can’t reach it.' : undefined}
                    />
                );
            })}
            {native.map((n) => (
                <Existing
                    key={n.port}
                    name={`${engineName[n.engine]} on port ${n.port}`}
                    meta={[n.version, 'native'].filter(Boolean).join(' ')}
                    state="open"
                    target={{ kind: 'native', engine: n.engine, port: n.port }}
                    login={{ user: template.engine === 'postgres' ? 'postgres' : 'root', password: '', database: '' }}
                    askFirst
                />
            ))}
        </ul>
    );
}

export function ChooseProvider(props: {
    template: Template;
    provider: Provider;
    discovery: Discovery | null;
    discovering: boolean;
    onRediscover: () => void;
    onProvider: (provider: Provider) => void;
    onSqlite: () => void;
    onBack: () => void;
    onNext: () => void;
}) {
    const { template, provider, discovery, discovering, onRediscover, onProvider, onSqlite, onBack, onNext } = props;
    const docker = discovery?.docker ?? null;
    const dockerReady = docker?.daemonRunning === true;
    const os = docker?.os ?? 'windows';

    return (
        <StepFrame
            title={`How should ${template.name} run?`}
            footer={
                <>
                    <Button variant="ghost" onClick={onBack}>
                        Back
                    </Button>
                    <Button variant="link" className="text-fg3 hover:text-foreground" onClick={onSqlite}>
                        Use SQLite instead
                    </Button>
                    <Button className="ml-auto" onClick={onNext} disabled={!discovery || (provider === 'docker' && !dockerReady)}>
                        Next
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-5">
                <DockerState status={docker} discovering={discovering} onRetry={onRediscover} />
                <div role="radiogroup" aria-label="Provider" className="flex gap-2">
                    <ProviderOption
                        value="docker"
                        current={provider}
                        disabled={!dockerReady}
                        onChoose={onProvider}
                        title="Docker (recommended)"
                        detail="A labelled container on 127.0.0.1 with its own volume."
                    />
                    <ProviderOption
                        value="native"
                        current={provider}
                        onChoose={onProvider}
                        title="Native install"
                        detail={`Installed with ${nativeManager[os]}. You approve the exact commands first.`}
                    />
                </div>
                <section aria-labelledby="existing-title" className="flex flex-col gap-1">
                    <h3 id="existing-title" className="font-medium">
                        Already on this machine
                    </h3>
                    {discovery ? (
                        <OnThisMachine template={template} discovery={discovery} onChanged={onRediscover} />
                    ) : (
                        <p role="status" className="text-fg3">
                            Looking for running servers…
                        </p>
                    )}
                    {discovery?.containersError && <p className="text-xs text-danger">{discovery.containersError}</p>}
                </section>
            </div>
        </StepFrame>
    );
}
