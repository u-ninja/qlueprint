import { create } from 'zustand';
import { commands, type AuditEvent_Serialize, type EventKind, type ExportFormat, type Verification_Serialize } from '@/bindings';
import { errorMessage } from './connections';

export type AuditEvent = AuditEvent_Serialize;

export type AuditFilters = { event: EventKind | null; connectionId: string | null; search: string };

export type Integrity = 'checking' | Verification_Serialize | { error: string };

export const eventLabel: Record<EventKind, string> = {
    connection_saved: 'Connection saved',
    connection_opened: 'Connected',
    connection_failed: 'Connect failed',
    connection_closed: 'Disconnected',
    connection_forgotten: 'Connection removed',
    credential_stored: 'Password stored',
    credential_deleted: 'Password deleted',
    query_run: 'Query',
    local_instance_created: 'Local database created',
    local_instance_started: 'Local database started',
    local_instance_stopped: 'Local database stopped',
    local_instance_removed: 'Local database removed',
    local_data_deleted: 'Local data deleted',
    sample_data_loaded: 'Sample data loaded',
    native_install_run: 'Native install run',
};

/** An entry failed when it carries an error: a failed connect or query */
export const failed = (event: AuditEvent) => event.details.error !== undefined;

type AuditState = {
    filters: AuditFilters;
    /** Newest first; more pages load as the list scrolls */
    events: AuditEvent[];
    nextCursor: number | null;
    /** Entries Rust couldn't write since launch (the action still ran) */
    failedWrites: number;
    loading: boolean;
    error: string | null;
    selectedId: number | null;
    integrity: Integrity | null;
    exportError: string | null;
    setFilters: (patch: Partial<AuditFilters>) => void;
    /** Reloads the first page for the current filters */
    load: () => Promise<void>;
    loadMore: () => Promise<void>;
    select: (id: number | null) => void;
    verify: () => Promise<void>;
    exportLog: (format: ExportFormat) => Promise<void>;
};

// Read from Rust each time the screen opens: the log is the source of truth, the store only a view of it
export const useAudit = create<AuditState>()((set, get) => {
    // A filter change can land while an older page is still loading; only the newest request may write
    let latest = 0;

    async function fetchPage(before: number | null) {
        const request = ++latest;
        const { event, connectionId, search } = get().filters;
        set({ loading: true });
        try {
            const page = await commands.listAuditEvents({
                event,
                connectionId,
                search: search.trim() || null,
                from: null,
                to: null,
                before,
                limit: null,
            });
            if (request !== latest) return;
            set((s) => ({
                events: before === null ? page.events : [...s.events, ...page.events],
                nextCursor: page.nextCursor,
                failedWrites: page.failedWrites,
                loading: false,
                error: null,
            }));
        } catch (error) {
            if (request === latest) set({ loading: false, error: errorMessage(error) });
        }
    }

    return {
        filters: { event: null, connectionId: null, search: '' },
        events: [],
        nextCursor: null,
        failedWrites: 0,
        loading: false,
        error: null,
        selectedId: null,
        integrity: null,
        exportError: null,

        setFilters: (patch) => {
            set((s) => ({ filters: { ...s.filters, ...patch } }));
            void fetchPage(null);
        },
        load: () => fetchPage(null),
        loadMore: async () => {
            const { nextCursor, loading } = get();
            if (nextCursor !== null && !loading) await fetchPage(nextCursor);
        },
        select: (selectedId) => set({ selectedId }),

        verify: async () => {
            set({ integrity: 'checking' });
            try {
                set({ integrity: await commands.verifyAuditLog() });
            } catch (error) {
                set({ integrity: { error: errorMessage(error) } });
            }
        },

        exportLog: async (format) => {
            let text: string;
            try {
                text = await commands.exportAuditLog(format);
            } catch (error) {
                set({ exportError: `Export failed: ${errorMessage(error)}` });
                return;
            }
            set({ exportError: null });
            const type = format === 'csv' ? 'text/csv' : 'application/json';
            const url = URL.createObjectURL(new Blob([text], { type }));
            const link = document.createElement('a');
            link.href = url;
            link.download = `qlueprint-audit-${new Date().toISOString().slice(0, 10)}.${format}`;
            link.click();
            URL.revokeObjectURL(url);
        },
    };
});
