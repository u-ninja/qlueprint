import type { ReactNode } from 'react';

/** One wizard step: a heading, a scrolling body and the step's actions along the bottom */
export function StepFrame({
    title,
    description,
    children,
    footer,
}: {
    title: string;
    description?: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
}) {
    return (
        <section aria-labelledby="local-step-title" className="flex min-h-0 flex-1 flex-col">
            <header className="flex-none px-5 pt-4 pb-3">
                <h2 id="local-step-title" className="text-base font-medium">
                    {title}
                </h2>
                {description && <p className="mt-1 text-fg3">{description}</p>}
            </header>
            <div className="min-h-0 flex-1 overflow-auto px-5 pb-4">{children}</div>
            {footer && <footer className="flex flex-none items-center gap-2 border-t border-border-soft px-5 py-3">{footer}</footer>}
        </section>
    );
}

/** Label/value rows: the review summary and the ready screen */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
    return (
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5">
            {rows.map(([label, value]) => (
                <div key={label} className="contents">
                    <dt className="text-fg3">{label}</dt>
                    <dd className="min-w-0 wrap-anywhere">{value}</dd>
                </div>
            ))}
        </dl>
    );
}

export const mono = 'font-mono text-xs';
