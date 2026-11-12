import type { LocalPlan, NativePlan } from '@/bindings';
import { Button } from '@/components/ui/button';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { engineName } from '@/lib/engines';
import { cn } from '@/lib/utils';
import { Facts, StepFrame, mono } from './StepFrame';

function Commands({ native }: { native: NativePlan }) {
    return (
        <pre
            className={cn(
                mono,
                'max-h-48 overflow-auto rounded-md border border-border-soft bg-editor px-3 py-2 leading-5 whitespace-pre-wrap select-text',
            )}
        >
            {native.commands.join('\n')}
            {native.setupSql && `\n\n${native.setupSql}`}
        </pre>
    );
}

/** Native installs change the system, so the exact commands are confirmed in their own dialog */
function ConsentButton({ native, onConfirm }: { native: NativePlan; onConfirm: () => void }) {
    return (
        <AlertDialog>
            <AlertDialogTrigger asChild>
                <Button className="ml-auto">Install…</Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="data-[size=default]:sm:max-w-xl">
                <AlertDialogHeader>
                    <AlertDialogTitle>Run these commands?</AlertDialogTitle>
                    <AlertDialogDescription>
                        QluePrint runs exactly these with {native.manager}
                        {native.elevated ? ', and your system asks for administrator approval' : ''}. Passwords are hidden here.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <Commands native={native} />
                {native.notes.length > 0 && (
                    <ul className="flex list-disc flex-col gap-1 pl-4 text-fg2">
                        {native.notes.map((n) => (
                            <li key={n}>{n}</li>
                        ))}
                    </ul>
                )}
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={onConfirm}>Run commands</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

const providerText = (plan: LocalPlan) =>
    plan.provider === 'docker'
        ? `Docker, image ${plan.image}`
        : plan.provider === 'native'
          ? `Native install with ${plan.native?.manager}`
          : 'SQLite file';

export function Review({ plan, onBack, onCreate }: { plan: LocalPlan; onBack: () => void; onCreate: (consent: string | null) => void }) {
    const rows: [string, string][] = [
        ['Engine', plan.provider === 'file' ? 'SQLite' : `${engineName[plan.engine]} ${plan.version}`],
        ['Provider', providerText(plan)],
    ];
    if (plan.port != null) rows.push(['Host and port', `${plan.host}:${plan.port}`]);
    rows.push(['Database', plan.database]);
    if (plan.user) rows.push(['User', plan.user]);
    if (plan.containerName) rows.push(['Container', plan.containerName]);
    rows.push([
        plan.provider === 'docker' ? 'Volume' : plan.provider === 'native' ? 'Data directory' : 'File',
        plan.storage || 'Chosen by the installer',
    ]);
    rows.push(['Sample data', plan.sampleData ? 'Yes, into the new database' : 'No']);

    return (
        <StepFrame
            title="Review"
            description="Nothing has changed on this machine yet."
            footer={
                <>
                    <Button variant="ghost" onClick={onBack}>
                        Back
                    </Button>
                    {plan.native ? (
                        <ConsentButton native={plan.native} onConfirm={() => onCreate(plan.native!.consentToken)} />
                    ) : (
                        <Button className="ml-auto" onClick={() => onCreate(null)}>
                            Create database
                        </Button>
                    )}
                </>
            }
        >
            <div className="flex flex-col gap-4">
                <Facts
                    rows={rows.map(([label, value]) => [
                        label,
                        <span className={label === 'Engine' || label === 'Sample data' ? undefined : mono}>{value}</span>,
                    ])}
                />
                {plan.warnings.map((w) => (
                    <p key={w} className="text-fg2">
                        {w}
                    </p>
                ))}
                {plan.native && (
                    <section aria-labelledby="native-commands" className="flex flex-col gap-1.5">
                        <h3 id="native-commands" className="font-medium">
                            Commands it runs
                        </h3>
                        <Commands native={plan.native} />
                        {plan.native.uninstall && (
                            <p className="text-xs text-fg3">QluePrint doesn’t uninstall servers. To remove it later: {plan.native.uninstall}</p>
                        )}
                    </section>
                )}
            </div>
        </StepFrame>
    );
}
