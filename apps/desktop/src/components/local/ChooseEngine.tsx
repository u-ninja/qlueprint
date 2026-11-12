import type { Engine, Template } from '@/bindings';
import { Button } from '@/components/ui/button';
import { ConnectDialog } from '@/components/shell/ConnectDialog';
import { StepFrame } from './StepFrame';

export function ChooseEngine({ templates, onChoose }: { templates: Template[]; onChoose: (engine: Engine) => void }) {
    return (
        <StepFrame
            title="Choose a database"
            description="QluePrint sets it up on this machine, loads sample data if you want it, and saves the connection."
            footer={
                <ConnectDialog>
                    <Button variant="link" className="px-0 text-fg3 hover:text-foreground">
                        Connect to an existing database instead
                    </Button>
                </ConnectDialog>
            }
        >
            <ul className="flex flex-col gap-1">
                {templates.map((t) => (
                    <li key={t.engine}>
                        <button
                            type="button"
                            onClick={() => onChoose(t.engine)}
                            className="flex w-full items-baseline gap-3 rounded-lg border border-border-soft px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-hover focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                        >
                            <span className="min-w-0 flex-1">
                                <span className="block font-medium">{t.name}</span>
                                <span className="block text-fg3">{t.description}</span>
                            </span>
                            <span className="flex-none font-mono text-[11px] text-fg4">
                                {t.versions.length ? t.versions.map((v) => v.id).join(' / ') : 'file'}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </StepFrame>
    );
}
