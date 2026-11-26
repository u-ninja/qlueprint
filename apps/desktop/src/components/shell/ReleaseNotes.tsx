import { Sparkles, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Change } from '@/lib/changelog';

function Group({ label, icon, tone, changes }: { label: string; icon: React.ReactNode; tone: string; changes: Change[] }) {
    if (!changes.length) return null;
    return (
        <section className="flex flex-col gap-2">
            <h4 className={cn('flex items-center gap-1.5 text-xs font-medium', tone)}>
                {icon}
                {label}
            </h4>
            <ul className="flex flex-col gap-2.5 border-l border-border-soft pl-3.5">
                {changes.map((c) => (
                    <li key={c.title + c.detail} className="text-[13px] leading-[1.45] text-fg3">
                        {c.title && <span className="font-medium text-fg">{c.title}. </span>}
                        {c.detail}
                    </li>
                ))}
            </ul>
        </section>
    );
}

/** One release's changes, split into what's new and what's fixed */
export function ReleaseNotes({ changes }: { changes: Change[] }) {
    return (
        <div className="flex flex-col gap-4">
            <Group
                label="New and improved"
                icon={<Sparkles className="size-3.5" aria-hidden />}
                tone="text-primary-text"
                changes={changes.filter((c) => !c.fixed)}
            />
            <Group
                label="Fixed"
                icon={<Wrench className="size-3.5" aria-hidden />}
                tone="text-success"
                changes={changes.filter((c) => c.fixed)}
            />
        </div>
    );
}
