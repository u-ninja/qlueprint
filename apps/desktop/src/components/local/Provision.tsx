import { useEffect, useRef, useState } from 'react';
import { Check, Circle, LoaderCircle, Minus, X } from 'lucide-react';
import { commands, events, type LocalCreated, type LocalRequest, type Stage, type StageState } from '@/bindings';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/stores/connections';
import { openConnection, useLocal } from '@/stores/local';
import { currentQuery, NO_QUERY, useQuery } from '@/stores/query';
import { engineName } from '@/lib/engines';
import { cn } from '@/lib/utils';
import { stageLabel, stagesFor } from './stages';
import { Facts, StepFrame, mono } from './StepFrame';

type StageView = { state: StageState; message: string | null };

const MAX_OUTPUT = 200;

function StageIcon({ state }: { state: StageState | undefined }) {
    const icon = 'size-3.5 flex-none';
    if (state === 'running' || state === 'output') return <LoaderCircle className={cn(icon, 'animate-spin text-primary-text')} aria-hidden />;
    if (state === 'done') return <Check className={cn(icon, 'text-success')} aria-hidden />;
    if (state === 'skipped') return <Minus className={cn(icon, 'text-fg3')} aria-hidden />;
    if (state === 'failed') return <X className={cn(icon, 'text-danger')} aria-hidden />;
    return <Circle className={cn(icon, 'text-fg4')} aria-hidden />;
}

const stateText: Record<StageState, string> = { running: 'in progress', output: 'in progress', done: 'done', skipped: 'skipped', failed: 'failed' };

/** Connection details without the password, for the clipboard */
function details(created: LocalCreated) {
    const { instance } = created;
    const lines = [`Engine: ${engineName[instance.engine]} ${instance.version}`];
    if (instance.port != null)
        lines.push(`Host: ${instance.host}`, `Port: ${instance.port}`, `Database: ${instance.database}`, `User: ${instance.user}`);
    else lines.push(`File: ${instance.dataPath}`);
    return lines.join('\n');
}

function Ready({ created, onSample }: { created: LocalCreated; onSample: (next: LocalCreated) => void }) {
    const setCreateOpen = useLocal((s) => s.setCreateOpen);
    const [copied, setCopied] = useState(false);
    const [retrying, setRetrying] = useState(false);
    const [retryError, setRetryError] = useState('');
    const { instance, connection, sampleError, starterSql } = created;

    async function open() {
        if (starterSql) {
            const query = useQuery.getState();
            // A draft the user wrote stays put: the starter script gets a tab of its own
            if (currentQuery(query) === NO_QUERY || currentQuery(query).sql.trim() !== '') query.newQuery();
            useQuery.getState().setSql(starterSql);
        }
        await openConnection(connection);
        setCreateOpen(false);
    }

    async function retrySample() {
        setRetrying(true);
        setRetryError('');
        try {
            const outcome = await commands.initSampleData(instance.id);
            onSample({ ...created, instance: outcome.instance, sampleError: null, starterSql: outcome.starterSql });
        } catch (err) {
            setRetryError(errorMessage(err));
        } finally {
            setRetrying(false);
        }
    }

    const sample =
        instance.sampleData === 'loaded' ? (
            'Loaded, example queries ready'
        ) : instance.sampleData === 'off' ? (
            'Not loaded'
        ) : (
            <span className="flex flex-col items-start gap-1.5">
                <span className="text-danger">{retryError || sampleError}</span>
                <Button variant="outline" size="xs" onClick={() => void retrySample()} disabled={retrying}>
                    {retrying ? 'Retrying…' : 'Retry sample data'}
                </Button>
            </span>
        );

    return (
        <StepFrame
            title="Ready"
            description="The database is running and its connection is saved. The password is in your system’s credential store."
            footer={
                <>
                    <Button variant="outline" onClick={() => void navigator.clipboard.writeText(details(created)).then(() => setCopied(true))}>
                        {copied ? 'Copied' : 'Copy connection details'}
                    </Button>
                    <Button className="ml-auto" onClick={() => void open()}>
                        Open in workspace
                    </Button>
                </>
            }
        >
            <Facts
                rows={[
                    ['Connection', connection.label],
                    ['Engine', `${engineName[instance.engine]} ${instance.version}`],
                    instance.port != null
                        ? ['Host and port', <span className={mono}>{`${instance.host}:${instance.port}`}</span>]
                        : ['File', <span className={mono}>{instance.dataPath}</span>],
                    ['Sample data', sample],
                ]}
            />
        </StepFrame>
    );
}

/** Runs the provisioning and shows each stage as Rust reports it */
export function Provision({ request, onBusy, onBack }: { request: LocalRequest; onBusy: (busy: boolean) => void; onBack: () => void }) {
    const [id] = useState(() => `p-${crypto.randomUUID()}`);
    const [stages, setStages] = useState<Partial<Record<Stage, StageView>>>({});
    const [output, setOutput] = useState<string[]>([]);
    const [cancellable, setCancellable] = useState(true);
    const [cancelling, setCancelling] = useState(false);
    const [error, setError] = useState('');
    const [created, setCreated] = useState<LocalCreated | null>(null);
    // StrictMode mounts effects twice in development; provisioning must start once
    const started = useRef(false);

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        let unlisten: (() => void) | undefined;
        onBusy(true);
        void (async () => {
            unlisten = await events.localProgress.listen(({ payload }) => {
                if (payload.provisioningId !== id) return;
                setCancellable(payload.cancellable);
                if (payload.state === 'output') {
                    setOutput((lines) => [...lines.slice(-(MAX_OUTPUT - 1)), payload.message ?? '']);
                    return;
                }
                if (payload.state === 'running') setOutput([]);
                setStages((s) => ({ ...s, [payload.stage]: { state: payload.state, message: payload.message ?? null } }));
            });
            try {
                setCreated(await commands.createLocalDatabase(id, request));
            } catch (err) {
                setError(errorMessage(err));
            } finally {
                unlisten?.();
                onBusy(false);
                void useLocal.getState().load();
            }
        })();
    }, [id, request, onBusy]);

    if (created) return <Ready created={created} onSample={setCreated} />;

    const order = stagesFor[request.provider];
    const running = !error;

    return (
        <StepFrame
            title={error ? 'Couldn’t create the database' : 'Creating the database'}
            description={error ? undefined : 'Each step appears as it happens on this machine.'}
            footer={
                running ? (
                    <Button
                        variant="outline"
                        className="ml-auto"
                        disabled={!cancellable || cancelling}
                        title={cancellable ? undefined : 'Too far along to stop safely'}
                        onClick={() => {
                            setCancelling(true);
                            void commands.cancelProvisioning(id);
                        }}
                    >
                        {cancelling ? 'Cancelling…' : 'Cancel'}
                    </Button>
                ) : (
                    <Button variant="outline" className="ml-auto" onClick={onBack}>
                        Back to configure
                    </Button>
                )
            }
        >
            <ol className="flex flex-col gap-1.5" aria-live="polite">
                {order.map((stage) => {
                    const view = stages[stage];
                    return (
                        <li key={stage} className="flex flex-col gap-0.5">
                            <span className={cn('flex items-center gap-2', !view && 'text-fg3')}>
                                <StageIcon state={view?.state} />
                                {stageLabel[stage]}
                                <span className="sr-only">{view ? stateText[view.state] : 'not started'}</span>
                            </span>
                            {view?.message && view.state !== 'failed' && (
                                <span className="pl-5.5 text-xs text-fg3 wrap-anywhere">{view.message}</span>
                            )}
                        </li>
                    );
                })}
            </ol>
            {output.length > 0 && running && (
                <pre className={cn(mono, 'mt-3 max-h-32 overflow-auto rounded-md border border-border-soft bg-editor px-3 py-2 text-fg2')}>
                    {output.slice(-8).join('\n')}
                </pre>
            )}
            {error && (
                <p role="alert" className="mt-4 rounded-lg border border-border-soft bg-surface p-3 whitespace-pre-wrap text-danger select-text">
                    {error}
                </p>
            )}
        </StepFrame>
    );
}
