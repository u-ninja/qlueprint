import type { ReactNode } from 'react';
import { StatusDot } from '@/components/shell/StatusDot';
import { eventLabel, failed, useAudit } from '@/stores/audit';
import { engineName } from '@/lib/engines';
import { count } from '@/lib/utils';
import { localTime } from './AuditList';

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <>
            <dt className="text-fg3">{label}</dt>
            <dd className="min-w-0 wrap-anywhere">{children}</dd>
        </>
    );
}

/** Everything one entry recorded, with the full SQL */
export function AuditDetails() {
    const event = useAudit((s) => s.events.find((e) => e.id === s.selectedId));

    if (!event) return <div className="grid h-full place-items-center text-fg3">Select an entry to see its details</div>;
    const { details } = event;
    const mono = 'font-mono text-xs tabular-nums';

    return (
        <section aria-label="Entry details" className="flex h-full flex-col">
            <header className="flex h-10 flex-none items-center gap-2 border-b border-border-soft px-4">
                <StatusDot state={failed(event) ? 'failed' : 'open'} />
                <h2 className="font-medium">{eventLabel[event.event]}</h2>
                <span className={`${mono} text-fg4`}>#{event.id}</span>
                <time dateTime={new Date(event.at).toISOString()} className={`${mono} ml-auto text-fg3`}>
                    {localTime(event.at)}
                </time>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-3 select-text">
                {details.sql !== undefined && (
                    <pre className="rounded-md border border-border-soft bg-editor px-3 py-2.5 font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap">
                        {details.sql}
                    </pre>
                )}
                <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1.5">
                    {details.label !== undefined && <Field label="Connection">{details.label}</Field>}
                    {details.engine !== undefined && <Field label="Engine">{engineName[details.engine]}</Field>}
                    {details.target !== undefined && (
                        <Field label={details.engine === 'sqlite' ? 'File' : 'Server'}>
                            <span className={mono}>{details.target}</span>
                        </Field>
                    )}
                    {details.database !== undefined && (
                        <Field label="Database">
                            <span className={mono}>{details.database}</span>
                        </Field>
                    )}
                    {details.rowsAffected !== undefined && (
                        <Field label="Rows">
                            <span className={mono}>{count(details.rowsAffected, 'row')}</span>
                        </Field>
                    )}
                    {details.durationMs !== undefined && (
                        <Field label="Duration">
                            <span className={mono}>{details.durationMs.toLocaleString()} ms</span>
                        </Field>
                    )}
                    {details.error !== undefined && (
                        <Field label="Error">
                            <span className={`${mono} whitespace-pre-wrap text-danger`}>{details.error}</span>
                        </Field>
                    )}
                    <Field label="Hash">
                        <span className={`${mono} break-all text-fg3`}>{event.hash}</span>
                    </Field>
                </dl>
            </div>
        </section>
    );
}
