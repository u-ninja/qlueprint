import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { commands, type Discovery, type Engine, type LocalPlan, type LocalRequest, type Provider, type Template } from '@/bindings';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { errorMessage } from '@/stores/connections';
import { useLocal } from '@/stores/local';
import { cn } from '@/lib/utils';
import { ChooseEngine } from './ChooseEngine';
import { ChooseProvider } from './ChooseProvider';
import { Configure } from './Configure';
import { Review } from './Review';
import { Provision } from './Provision';
import { generatePassword } from './stages';

export type Step = 'engine' | 'provider' | 'configure' | 'review' | 'create';

/** The wizard's form state; `toRequest` turns it into what Rust validates */
export type Draft = Omit<LocalRequest, 'consent'>;

export function toRequest(draft: Draft, consent: string | null = null): LocalRequest {
    return { ...draft, consent };
}

function draftFor(template: Template, provider: Provider): Draft {
    return {
        engine: template.engine,
        provider,
        version: template.versions[0]?.id ?? '',
        database: 'qlueprint_demo',
        user: template.defaultUser,
        password: generatePassword(),
        rootPassword: template.hasRootPassword ? generatePassword() : '',
        port: template.defaultPort ?? 0,
        containerName: '',
        sampleData: true,
    };
}

const steps: { value: Step; label: string }[] = [
    { value: 'engine', label: 'Database' },
    { value: 'provider', label: 'Provider' },
    { value: 'configure', label: 'Configure' },
    { value: 'review', label: 'Review' },
    { value: 'create', label: 'Create' },
];

function StepList({ current, skipProvider }: { current: Step; skipProvider: boolean }) {
    const shown = steps.filter((s) => !(skipProvider && s.value === 'provider'));
    const index = shown.findIndex((s) => s.value === current);
    return (
        <ol aria-label="Steps" className="flex flex-col gap-0.5">
            {shown.map((s, i) => (
                <li
                    key={s.value}
                    aria-current={i === index ? 'step' : undefined}
                    className={cn(
                        'flex h-7 items-center gap-2 rounded-md px-2',
                        i === index && 'bg-muted font-medium text-foreground',
                        i < index && 'text-fg2',
                        i > index && 'text-fg4',
                    )}
                >
                    <span className="grid size-4 place-items-center font-mono text-[11px] tabular-nums" aria-hidden>
                        {i < index ? <Check className="size-3.5 text-success" /> : i + 1}
                    </span>
                    {s.label}
                </li>
            ))}
        </ol>
    );
}

/** "Create local database": one focused flow from picking an engine to an open connection */
function Wizard({ onBusy }: { onBusy: (busy: boolean) => void }) {
    const [step, setStep] = useState<Step>('engine');
    const [templates, setTemplates] = useState<Template[]>([]);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [discovery, setDiscovery] = useState<Discovery | null>(null);
    const [discovering, setDiscovering] = useState(false);
    const [plan, setPlan] = useState<LocalPlan | null>(null);
    const [consent, setConsent] = useState<string | null>(null);
    const [loadError, setLoadError] = useState('');

    useEffect(() => {
        commands.localDatabaseTemplates().then(setTemplates, (e) => setLoadError(errorMessage(e)));
    }, []);

    async function discover() {
        setDiscovering(true);
        try {
            const found = await commands.discoverLocalDatabases();
            setDiscovery(found);
            // Docker can't be picked while it's missing or stopped; native is the alternative
            if (!found.docker.daemonRunning) setDraft((d) => (d?.provider === 'docker' ? { ...d, provider: 'native' } : d));
        } finally {
            setDiscovering(false);
        }
    }

    function chooseEngine(engine: Engine) {
        const template = templates.find((t) => t.engine === engine);
        if (!template) return;
        if (engine === 'sqlite') {
            setDraft(draftFor(template, 'file'));
            setStep('configure');
            return;
        }
        // Docker unless discovery says otherwise (see discover); the provider step lets the user change it
        setDraft(draftFor(template, discovery?.docker.daemonRunning === false ? 'native' : 'docker'));
        setStep('provider');
        void discover();
    }

    const template = templates.find((t) => t.engine === draft?.engine);
    const update = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

    return (
        <div className="grid h-full min-h-0 grid-cols-[11rem_1fr]">
            <nav aria-label="Create local database" className="flex flex-col gap-4 border-r border-border-soft bg-panel px-3 py-4">
                <DialogTitle className="px-2 text-sm">Create local database</DialogTitle>
                <StepList current={step} skipProvider={draft?.engine === 'sqlite'} />
            </nav>
            <div className="flex min-h-0 min-w-0 flex-col">
                {loadError && (
                    <p role="alert" className="p-5 text-danger">
                        {loadError}
                    </p>
                )}
                {step === 'engine' && <ChooseEngine templates={templates} onChoose={chooseEngine} />}
                {step === 'provider' && draft && template && (
                    <ChooseProvider
                        template={template}
                        provider={draft.provider}
                        discovery={discovery}
                        discovering={discovering}
                        onRediscover={discover}
                        onProvider={(provider) => update({ provider })}
                        onSqlite={() => chooseEngine('sqlite')}
                        onBack={() => setStep('engine')}
                        onNext={() => setStep('configure')}
                    />
                )}
                {step === 'configure' && draft && template && (
                    <Configure
                        template={template}
                        draft={draft}
                        os={discovery?.docker.os ?? null}
                        onChange={update}
                        onBack={() => setStep(draft.engine === 'sqlite' ? 'engine' : 'provider')}
                        onPlanned={(next) => {
                            setPlan(next);
                            setStep('review');
                        }}
                    />
                )}
                {step === 'review' && draft && plan && (
                    <Review
                        plan={plan}
                        onBack={() => setStep('configure')}
                        onCreate={(token) => {
                            setConsent(token);
                            setStep('create');
                        }}
                    />
                )}
                {step === 'create' && draft && <Provision request={toRequest(draft, consent)} onBusy={onBusy} onBack={() => setStep('configure')} />}
            </div>
        </div>
    );
}

export function CreateLocalDialog() {
    const open = useLocal((s) => s.createOpen);
    const setOpen = useLocal((s) => s.setCreateOpen);
    // While Rust provisions, closing would lose track of it; Cancel is the way out
    const [busy, setBusy] = useState(false);

    return (
        <Dialog open={open} onOpenChange={(next) => (busy && !next ? undefined : setOpen(next))}>
            <DialogContent showCloseButton={!busy} className="h-[34rem] max-h-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-[46rem]">
                <DialogDescription className="sr-only">
                    Pick an engine, choose Docker, a native install or a SQLite file, then review and create.
                </DialogDescription>
                {/* Mounted only while open, so each opening starts fresh */}
                {open && <Wizard onBusy={setBusy} />}
            </DialogContent>
        </Dialog>
    );
}
