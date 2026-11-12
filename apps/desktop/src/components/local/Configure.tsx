import { useState, type ComponentProps, type ReactNode } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import { commands, type LocalPlan, type Os, type Template } from '@/bindings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { errorMessage } from '@/stores/connections';
import { cn } from '@/lib/utils';
import { toRequest, type Draft } from './CreateLocalDialog';
import { generatePassword } from './stages';
import { StepFrame, mono } from './StepFrame';

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
    return (
        <div className="grid gap-1.5">
            <Label htmlFor={id}>{label}</Label>
            {children}
            {hint && <p className="text-xs text-fg3">{hint}</p>}
        </div>
    );
}

function TextField({ id, label, hint, ...props }: { id: string; label: string; hint?: ReactNode } & ComponentProps<typeof Input>) {
    return (
        <Field id={id} label={label} hint={hint}>
            <Input id={id} spellCheck={false} autoComplete="off" {...props} />
        </Field>
    );
}

/** A generated password, shown so it can be copied, and replaceable by typing or generating a new one */
function PasswordField({
    id,
    label,
    value,
    hint,
    onChange,
}: {
    id: string;
    label: string;
    value: string;
    hint: string;
    onChange: (value: string) => void;
}) {
    const [copied, setCopied] = useState(false);
    return (
        <Field id={id} label={label} hint={hint}>
            <div className="flex gap-1.5">
                <Input
                    id={id}
                    value={value}
                    onChange={(e) => {
                        setCopied(false);
                        onChange(e.target.value);
                    }}
                    spellCheck={false}
                    autoComplete="new-password"
                    className={cn(mono, 'min-w-0 flex-1')}
                />
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={copied ? 'Copied' : `Copy ${label.toLowerCase()}`}
                    title={copied ? 'Copied' : 'Copy'}
                    onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
                >
                    <Copy aria-hidden />
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={`Generate a new ${label.toLowerCase()}`}
                    title="Generate a new one"
                    onClick={() => {
                        setCopied(false);
                        onChange(generatePassword());
                    }}
                >
                    <RefreshCw aria-hidden />
                </Button>
            </div>
        </Field>
    );
}

export function Configure(props: {
    template: Template;
    draft: Draft;
    os: Os | null;
    onChange: (patch: Partial<Draft>) => void;
    onBack: () => void;
    onPlanned: (plan: LocalPlan) => void;
}) {
    const { template, draft, os, onChange, onBack, onPlanned } = props;
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState('');
    const [plan, setPlan] = useState<LocalPlan | null>(null);
    const server = draft.engine !== 'sqlite';
    const native = draft.provider === 'native';
    // The Windows installers (EDB, MariaDB MSI) take the admin password; Homebrew and Linux use socket auth
    const rootPassword = template.hasRootPassword ? !native || os === 'windows' : native && os === 'windows';

    async function next() {
        setChecking(true);
        setError('');
        try {
            const checked = await commands.planLocalDatabase(toRequest(draft));
            if (checked.blockers.length) setPlan(checked);
            else onPlanned(checked);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setChecking(false);
        }
    }

    const change = (patch: Partial<Draft>) => {
        setPlan(null);
        onChange(patch);
    };

    return (
        <StepFrame
            title={`Configure ${template.name}`}
            description={
                server
                    ? `${native ? 'Native install' : 'Docker container'} on 127.0.0.1. Defaults are filled in; change what you need.`
                    : 'A database file in QluePrint’s app data folder. The review shows the full path.'
            }
            footer={
                <>
                    <Button variant="ghost" onClick={onBack}>
                        Back
                    </Button>
                    <Button className="ml-auto" onClick={() => void next()} disabled={checking}>
                        {checking ? 'Checking…' : 'Review'}
                    </Button>
                </>
            }
        >
            <form
                className="grid grid-cols-2 gap-x-3 gap-y-3"
                onSubmit={(e) => {
                    e.preventDefault();
                    void next();
                }}
            >
                {server && (
                    <div className="col-span-2 grid gap-1.5">
                        <span id="local-version" className="text-sm font-medium">
                            Version
                        </span>
                        <div role="radiogroup" aria-labelledby="local-version" className="flex w-fit rounded-lg p-0.5 ring-1 ring-border">
                            {template.versions.map((v) => (
                                <button
                                    key={v.id}
                                    type="button"
                                    role="radio"
                                    aria-checked={draft.version === v.id}
                                    onClick={() => change({ version: v.id })}
                                    className={cn(
                                        'rounded-md px-3 py-1 text-fg3 transition-colors hover:text-foreground',
                                        draft.version === v.id && 'bg-muted text-foreground',
                                    )}
                                >
                                    {native ? v.id : v.tag}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                <TextField
                    id="local-database"
                    label={server ? 'Database name' : 'File name'}
                    value={draft.database}
                    onChange={(e) => change({ database: e.target.value })}
                    hint={server ? undefined : `Saved as ${draft.database || '…'}.db`}
                    required
                />
                {server && <TextField id="local-user" label="User" value={draft.user} onChange={(e) => change({ user: e.target.value })} required />}
                {server && (
                    <div className="col-span-2">
                        <PasswordField
                            id="local-password"
                            label="Password"
                            value={draft.password}
                            onChange={(password) => change({ password })}
                            hint="Generated for you. It goes into your system’s credential store, never into a file."
                        />
                    </div>
                )}
                {server && rootPassword && (
                    <div className="col-span-2">
                        <PasswordField
                            id="local-root-password"
                            label={native ? 'Admin password' : 'Root password'}
                            value={draft.rootPassword}
                            onChange={(rootPassword) => change({ rootPassword })}
                            hint={
                                native
                                    ? 'For the server’s admin account. Copy it now: QluePrint doesn’t show it again.'
                                    : 'For the root account. Copy it now: QluePrint doesn’t show it again.'
                            }
                        />
                    </div>
                )}
                {server && (
                    <TextField
                        id="local-port"
                        label="Port"
                        type="number"
                        min={1024}
                        max={65535}
                        value={draft.port}
                        onChange={(e) => change({ port: Number(e.target.value) })}
                        className={mono}
                        hint={native && os !== 'windows' ? 'Native installs use the default port.' : undefined}
                    />
                )}
                {server && !native && (
                    <TextField
                        id="local-container"
                        label="Container name"
                        value={draft.containerName}
                        placeholder={`qlueprint-${draft.engine}-${draft.port}`}
                        onChange={(e) => change({ containerName: e.target.value })}
                        className={mono}
                    />
                )}
                <div className="col-span-2 flex items-center justify-between gap-3 pt-1">
                    <Label htmlFor="local-sample" className="flex flex-col items-start gap-0.5 font-normal">
                        Sample data
                        <span className="text-xs text-fg3">Customers, products, orders and employees, plus example queries</span>
                    </Label>
                    <Switch id="local-sample" checked={draft.sampleData} onCheckedChange={(sampleData) => change({ sampleData })} />
                </div>
                {/* Enter submits from any field */}
                <button type="submit" hidden />
            </form>

            {(error || plan) && (
                <div role="alert" className="mt-4 flex flex-col gap-2 rounded-lg border border-border-soft bg-surface p-3">
                    {error && <p className="text-danger">{error}</p>}
                    {plan?.blockers.map((b) => (
                        <p key={b} className="text-danger">
                            {b}
                        </p>
                    ))}
                    {plan?.suggestedPort != null && (
                        <Button variant="outline" size="sm" className="w-fit" onClick={() => change({ port: plan.suggestedPort! })}>
                            Use port {plan.suggestedPort}
                        </Button>
                    )}
                    {plan?.native && !plan.native.supported && plan.native.commands.length > 0 && (
                        <>
                            <p className="text-fg2">To set it up yourself:</p>
                            <pre className={cn(mono, 'rounded-md bg-editor px-3 py-2 whitespace-pre-wrap select-text')}>
                                {plan.native.commands.join('\n')}
                            </pre>
                        </>
                    )}
                </div>
            )}
        </StepFrame>
    );
}
