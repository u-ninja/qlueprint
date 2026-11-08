import type { ConnectRequest } from '@/bindings';

export type Engine = ConnectRequest['kind'];

/** Display name of each database type, in the order the connect dialog offers them */
export const engineName: Record<Engine, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite' };
