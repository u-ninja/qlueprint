import type { ConnectionState } from '@/stores/connections';

const tone: Record<ConnectionState, string> = {
    open: 'bg-success',
    connecting: 'bg-warning',
    failed: 'bg-danger',
    closed: 'bg-fg4',
};

/** The connection-state dot used wherever a connection is named: explorer, toolbar, status bar */
export function StatusDot({ state }: { state: ConnectionState }) {
    return <span aria-hidden className={`size-1.5 flex-none rounded-full ${tone[state]}`} />;
}
