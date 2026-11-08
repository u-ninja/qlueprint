import type { Engine } from '@/bindings';

/** Display name of each database type. MariaDB connects through the MySQL driver, so only local databases tell it apart */
export const engineName: Record<Engine, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', sqlite: 'SQLite' };
