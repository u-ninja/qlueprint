import type { ConnectRequest, Engine } from '@/bindings';
import { defaultPort } from './connection-string';

/** Display name of each database type. MariaDB connects through the MySQL driver, so only local databases tell it apart */
export const engineName: Record<Engine, string> = {
    postgres: 'PostgreSQL',
    mysql: 'MySQL',
    mariadb: 'MariaDB',
    mssql: 'SQL Server',
    sqlite: 'SQLite',
};

/** A database type the connect dialog offers; its logo is EngineLogo with the same id */
export type ConnectEngine = {
    id: Engine;
    /** The driver it connects (and saves) as: MariaDB is 'mysql' */
    kind: ConnectRequest['kind'];
    /** null: a file (path field), otherwise a server (host, port, user, password, database) */
    port: number | null;
    user: string;
    /** What an empty database field means on this server */
    noDatabase: string;
    /** The connection string example shown as a placeholder */
    example: string;
    /** Has databases above its schemas (MySQL's databases are its schemas) */
    databases: boolean;
};

// In the dialog's tile order
export const connectEngines: ConnectEngine[] = [
    {
        id: 'postgres',
        kind: 'postgres',
        port: defaultPort.postgres,
        user: 'postgres',
        noDatabase: 'Same as user',
        example: 'postgres://user:password@localhost:5432/database',
        databases: true,
    },
    {
        id: 'mysql',
        kind: 'mysql',
        port: defaultPort.mysql,
        user: 'root',
        noDatabase: 'None',
        example: 'mysql://user:password@localhost:3306/database',
        databases: false,
    },
    {
        id: 'mariadb',
        kind: 'mysql',
        port: defaultPort.mariadb,
        user: 'root',
        noDatabase: 'None',
        example: 'mariadb://user:password@localhost:3306/database',
        databases: false,
    },
    {
        id: 'mssql',
        kind: 'mssql',
        port: defaultPort.mssql,
        user: '',
        noDatabase: 'The login’s default',
        example: 'Server=tcp:myserver.database.windows.net,1433;Database=shop;Authentication=Active Directory Interactive',
        databases: true,
    },
    { id: 'sqlite', kind: 'sqlite', port: null, user: '', noDatabase: '', example: 'sqlite:///path/to/database.db', databases: false },
];

export const connectEngine = (id: Engine) => connectEngines.find((e) => e.id === id) ?? connectEngines[0];

/** Postgres and SQL Server: a database level above the schemas */
export const hasDatabases = (id: Engine) => connectEngine(id).databases;
