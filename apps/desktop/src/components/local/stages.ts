import type { Provider, Stage } from '@/bindings';

export const stageLabel: Record<Stage, string> = {
    checking_runtime: 'Checking runtime',
    pulling_image: 'Pulling image',
    creating_storage: 'Creating storage',
    creating_container: 'Creating container',
    installing: 'Installing',
    starting: 'Starting',
    waiting_for_health: 'Waiting for health check',
    creating_database: 'Creating database and user',
    initializing_sample_data: 'Initializing sample data',
    validating: 'Validating',
    registering_connection: 'Registering connection',
    ready: 'Ready',
};

/** The stages each provider goes through, in order (Rust sends them as they happen) */
export const stagesFor: Record<Provider, Stage[]> = {
    docker: [
        'checking_runtime',
        'pulling_image',
        'creating_storage',
        'creating_container',
        'starting',
        'waiting_for_health',
        'initializing_sample_data',
        'validating',
        'registering_connection',
        'ready',
    ],
    native: [
        'checking_runtime',
        'installing',
        'starting',
        'waiting_for_health',
        'creating_database',
        'initializing_sample_data',
        'validating',
        'registering_connection',
        'ready',
    ],
    file: ['checking_runtime', 'creating_storage', 'initializing_sample_data', 'validating', 'registering_connection', 'ready'],
};

// No quotes, spaces, \, ` or $: Rust refuses those (they'd need escaping in SQL and installer arguments)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.';

/** A random 20-character password from the OS's secure random source */
export function generatePassword(length = 20) {
    const bytes = crypto.getRandomValues(new Uint32Array(length));
    return Array.from(bytes, (n) => ALPHABET[n % ALPHABET.length]).join('');
}
