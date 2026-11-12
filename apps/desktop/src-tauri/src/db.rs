//! Open database connections and read their schema tree.
//!
//! Pools are keyed by the saved connection's id, so the UI and Rust share one id space and a
//! reloaded UI finds its pools still open. The passwords inside them never leave Rust.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlSslMode};
use sqlx::pool::PoolOptions;
use sqlx::postgres::{PgConnectOptions, PgPool, PgSslMode};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
use tauri::State;

use crate::audit::{Audit, EventKind};
use crate::mssql::{self, MssqlLogin, MssqlPool};
use crate::saved::Saved;

// Fail fast on an unreachable host instead of sqlx's 30s default.
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
// A desktop client needs few connections: explorer + a couple of query tabs.
pub(crate) const MAX_CONNECTIONS: u32 = 4;
// Pools for a Postgres connection's other databases ("Show all databases").
const OTHER_DATABASE_CONNECTIONS: u32 = 2;

// pg_catalog, not information_schema: the latter runs a privilege check per row and is much
// slower on big catalogs. LEFT JOIN keeps empty schemas; partitions are hidden (their parent is
// listed); pg_* and information_schema are system schemas. Size is table + indexes + TOAST; a
// partitioned table has no storage of its own, so it sums its partition tree; views have none.
const PG_SCHEMAS: &str = r"
    SELECT n.nspname::text, c.relname::text, c.relkind IN ('v', 'm'),
           CASE c.relkind
             WHEN 'p' THEN (SELECT sum(pg_total_relation_size(relid))::int8 FROM pg_partition_tree(c.oid))
             WHEN 'r' THEN pg_total_relation_size(c.oid)
             WHEN 'm' THEN pg_total_relation_size(c.oid)
           END
    FROM pg_catalog.pg_namespace n
    LEFT JOIN pg_catalog.pg_class c
      ON c.relnamespace = n.oid
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND NOT c.relispartition
    WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\_%'
    ORDER BY 1, 2";

/// MySQL's own databases, hidden from the explorer and the database pickers.
macro_rules! mysql_user_databases {
    () => {
        "SCHEMA_NAME NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema')"
    };
}

// MySQL has no schema level under a database, so each database is listed as a schema.
// Ordering on the binary name keeps each database's rows together even when two names differ
// only in case. Size is data + indexes as the server last measured them; NULL for views.
macro_rules! mysql_schemas {
    ($filter:expr) => {
        concat!(
            "SELECT s.SCHEMA_NAME, t.TABLE_NAME, t.TABLE_TYPE = 'VIEW',
                CAST(t.DATA_LENGTH + t.INDEX_LENGTH AS SIGNED)
            FROM information_schema.SCHEMATA s
            LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
            WHERE s.",
            $filter,
            " ORDER BY CAST(s.SCHEMA_NAME AS BINARY), t.TABLE_NAME"
        )
    };
}
const MYSQL_SCHEMAS: &str = mysql_schemas!(mysql_user_databases!());
// One database only: filtered by the server, so other databases' tables never come back.
const MYSQL_SCHEMA: &str = mysql_schemas!("SCHEMA_NAME = ?");

const MYSQL_DATABASES: &str = concat!(
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE ",
    mysql_user_databases!(),
    " ORDER BY CAST(SCHEMA_NAME AS BINARY)"
);

// Template databases can't be queried, and datallowconn = false ones refuse connections.
const PG_DATABASES: &str = "SELECT datname::text FROM pg_catalog.pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1";

// Routines, listed with the schemas. Postgres: functions and procedures (PG 11+'s prokind), not
// ones an extension installed. SQL Server: P/PC procedures, FN/IF/TF/FS/FT functions.
const PG_ROUTINES: &str = r"
    SELECT n.nspname::text, p.proname::text, p.prokind = 'p', pg_get_function_identity_arguments(p.oid)
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prokind IN ('f', 'p') AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    ORDER BY 1, 2, 4";
macro_rules! mysql_routines {
    ($filter:expr) => {
        concat!(
            "SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE = 'PROCEDURE', CAST(NULL AS CHAR)
            FROM information_schema.ROUTINES WHERE ",
            $filter,
            " ORDER BY CAST(ROUTINE_SCHEMA AS BINARY), ROUTINE_NAME"
        )
    };
}
const MYSQL_ROUTINES: &str = mysql_routines!(
    "ROUTINE_SCHEMA NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema')"
);
const MYSQL_ROUTINES_IN: &str = mysql_routines!("ROUTINE_SCHEMA = ?");
const MSSQL_ROUTINES: &str = r"
    SELECT SCHEMA_NAME(o.schema_id), o.name, CASE WHEN o.type IN ('P', 'PC') THEN 1 ELSE 0 END, NULL
    FROM sys.objects o
    WHERE o.type IN ('P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT') AND o.is_ms_shipped = 0
    ORDER BY 1, 2";

// shortcut: only the "main" database, also list ATTACHed ones once the UI can attach.
const SQLITE_TABLES: &str = r"
    SELECT name, type = 'view' FROM sqlite_schema
    WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
    ORDER BY name";

// Columns for autocomplete, in table order. Same schema filters as the explorer's lists.
const PG_COLUMNS: &str = r"
    SELECT n.nspname::text, c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod)
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE a.attnum > 0 AND NOT a.attisdropped
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
      AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\_%'
    ORDER BY 1, 2, a.attnum";

macro_rules! mysql_columns {
    ($filter:expr) => {
        concat!(
            "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE ",
            $filter,
            " ORDER BY CAST(TABLE_SCHEMA AS BINARY), TABLE_NAME, ORDINAL_POSITION"
        )
    };
}
const MYSQL_ALL_COLUMNS: &str = mysql_columns!(
    "TABLE_SCHEMA NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema')"
);
const MYSQL_COLUMNS: &str = mysql_columns!("TABLE_SCHEMA = ?");

const SQLITE_COLUMNS: &str = r"
    SELECT 'main', m.name, p.name, p.type FROM sqlite_schema m
    JOIN pragma_table_info(m.name) p
    WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\_%' ESCAPE '\'
    ORDER BY m.name, p.cid";

// SQL Server: the db_* role schemas (ids from 16384), sys, INFORMATION_SCHEMA and guest are the
// system's. Size is every partition of the table and its indexes, summed once per object rather
// than per row; views have none. (sys.dm_db_partition_stats would need VIEW DATABASE STATE.)
// Fabric and Synapse (EngineEdition 11, 6) keep table data outside those pages: size unknown there.
const MSSQL_SCHEMAS: &str = r"
    SELECT s.name, o.name, CASE WHEN o.type = 'V' THEN 1 ELSE 0 END,
           CASE WHEN o.type = 'U' AND CAST(SERVERPROPERTY('EngineEdition') AS int) NOT IN (6, 11)
                THEN z.size_bytes END
    FROM sys.schemas s
    LEFT JOIN sys.objects o ON o.schema_id = s.schema_id AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
    LEFT JOIN (SELECT p.object_id, SUM(a.total_pages) * 8192 AS size_bytes FROM sys.partitions p
               JOIN sys.allocation_units a ON a.container_id = p.partition_id
               GROUP BY p.object_id) z ON z.object_id = o.object_id
    WHERE s.schema_id < 16384 AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')
    ORDER BY s.name, o.name";

// Offline databases and ones this login can't open are left out, like the system ones
const MSSQL_DATABASES: &str = r"
    SELECT name FROM sys.databases
    WHERE name NOT IN ('master', 'tempdb', 'model', 'msdb') AND state = 0 AND HAS_DBACCESS(name) = 1
    ORDER BY name";

/// A column's declared type as SQL Server writes it: `nvarchar(50)`, `decimal(10,2)`,
/// `datetime2(3)`. Alias types (`sysname`, user-defined) keep their own name.
macro_rules! mssql_type {
    () => {
        "TYPE_NAME(c.user_type_id) + CASE
           WHEN c.user_type_id <> c.system_type_id THEN ''
           WHEN TYPE_NAME(c.system_type_id) IN ('varchar', 'char', 'varbinary', 'binary')
             THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(5)) END + ')'
           WHEN TYPE_NAME(c.system_type_id) IN ('nvarchar', 'nchar')
             THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(5)) END + ')'
           WHEN TYPE_NAME(c.system_type_id) IN ('decimal', 'numeric')
             THEN '(' + CAST(c.precision AS varchar(3)) + ',' + CAST(c.scale AS varchar(3)) + ')'
           WHEN TYPE_NAME(c.system_type_id) IN ('datetime2', 'time', 'datetimeoffset')
             THEN '(' + CAST(c.scale AS varchar(3)) + ')'
           ELSE '' END"
    };
}
pub(crate) use mssql_type;

const MSSQL_COLUMNS: &str = concat!(
    "SELECT s.name, o.name, c.name, ",
    mssql_type!(),
    " FROM sys.columns c
    JOIN sys.objects o ON o.object_id = c.object_id AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    ORDER BY s.name, o.name, c.column_id"
);

/// Postgres' TLS modes. MySQL reads them as its own: allow and prefer are PREFERRED, verify-full
/// is VERIFY_IDENTITY.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disable,
    Allow,
    /// TLS when the server offers it, without checking its certificate: the drivers' default.
    #[default]
    Prefer,
    Require,
    /// Require, and check the certificate was issued by a trusted CA.
    VerifyCa,
    /// Verify-ca, and check the certificate names the host.
    VerifyFull,
}

impl SslMode {
    fn is_default(&self) -> bool {
        *self == Self::default()
    }

    fn postgres(self) -> PgSslMode {
        match self {
            Self::Disable => PgSslMode::Disable,
            Self::Allow => PgSslMode::Allow,
            Self::Prefer => PgSslMode::Prefer,
            Self::Require => PgSslMode::Require,
            Self::VerifyCa => PgSslMode::VerifyCa,
            Self::VerifyFull => PgSslMode::VerifyFull,
        }
    }

    fn mysql(self) -> MySqlSslMode {
        match self {
            Self::Disable => MySqlSslMode::Disabled,
            Self::Allow | Self::Prefer => MySqlSslMode::Preferred,
            Self::Require => MySqlSslMode::Required,
            Self::VerifyCa => MySqlSslMode::VerifyCa,
            Self::VerifyFull => MySqlSslMode::VerifyIdentity,
        }
    }
}

/// Where a network database server is and who to sign in as.
#[derive(Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Empty means the server's default: for Postgres a database named after the user, for
    /// MySQL none (queries then name the database, as in `shop.orders`).
    pub database: String,
    /// List every database on the server in the explorer, not just `database`. Missing means
    /// off, so connections saved before the option existed still load. (specta splits types with
    /// a defaulted field into `_Serialize`/`_Deserialize` copies; here both have the same shape.)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub show_all_databases: bool,
    /// Missing means prefer, what connections saved before the option did.
    #[serde(default, skip_serializing_if = "SslMode::is_default")]
    pub ssl_mode: SslMode,
    /// A CA certificate (PEM file) for verify-ca and verify-full. Empty: the bundled public CAs.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ssl_ca: String,
}

#[derive(Deserialize, Type)]
pub struct ServerLogin {
    #[serde(flatten)]
    pub server: Server,
    pub password: String,
}

#[derive(Deserialize, Type)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ConnectRequest {
    Postgres(ServerLogin),
    Mysql(ServerLogin),
    Mssql(MssqlLogin),
    Sqlite { path: String },
}

// Every pool type is an Arc inside, so cloning one out of the map is O(1).
#[derive(Clone)]
pub(crate) enum Pool {
    Postgres(PgPool),
    Mysql(MySqlPool),
    Mssql(MssqlPool),
    Sqlite(SqlitePool),
}

impl Pool {
    pub(crate) async fn close(self) {
        match self {
            Pool::Postgres(p) => p.close().await,
            Pool::Mysql(p) => p.close().await,
            Pool::Mssql(p) => p.close().await,
            Pool::Sqlite(p) => p.close().await,
        }
    }
}

/// An open connection: its pool, plus what the explorer and the database pickers need.
#[derive(Clone)]
pub(crate) struct Open {
    pub(crate) pool: Pool,
    /// The database the pool is connected to: Postgres' and SQL Server's actual one (even when
    /// the saved database was empty), MySQL's saved one (may be empty), `main` for SQLite.
    database: String,
    show_all: bool,
    /// Postgres with `show_all` only: the login, to open other databases on the same server.
    pg_options: Option<PgConnectOptions>,
    /// Postgres and SQL Server pools for those other databases, opened on first use. Shared by
    /// every clone.
    others: Arc<Mutex<HashMap<String, Pool>>>,
}

impl Open {
    fn new(
        pool: Pool,
        database: String,
        show_all: bool,
        pg_options: Option<PgConnectOptions>,
    ) -> Self {
        Self {
            pool,
            database,
            show_all,
            pg_options,
            others: Arc::default(),
        }
    }

    fn sqlite(pool: SqlitePool) -> Self {
        Self::new(Pool::Sqlite(pool), "main".into(), false, None)
    }

    /// The one database this connection is limited to, or `None` for the whole server
    /// ("Show all databases" on, or nothing saved to limit it to).
    fn scope(&self) -> Option<&str> {
        (!self.show_all && !self.database.is_empty()).then_some(self.database.as_str())
    }

    fn others(&self) -> std::sync::MutexGuard<'_, HashMap<String, Pool>> {
        self.others.lock().expect("database pools lock poisoned")
    }

    /// The pool `others` holds for `database`, else the one `open` opens. Two requests can race
    /// to open the same database; the first one stored wins and the other closes.
    async fn other(
        &self,
        database: &str,
        open: impl Future<Output = Result<Pool, CommandError>>,
    ) -> Result<Pool, CommandError> {
        if let Some(pool) = self.others().get(database) {
            return Ok(pool.clone());
        }
        let pool = open.await?;
        let existing = match self.others().entry(database.to_owned()) {
            Entry::Occupied(slot) => slot.get().clone(),
            Entry::Vacant(slot) => return Ok(slot.insert(pool).clone()),
        };
        pool.close().await;
        Ok(existing)
    }

    /// The pool for `database`: the main one for its own database (or none given, or MySQL and
    /// SQLite, which don't need another pool). Postgres and SQL Server get one per other database,
    /// opened with the same login the first time it's asked for: a SQL Server pool is bound to its
    /// database because Azure SQL can't `USE` another one.
    pub(crate) async fn pool_for(&self, database: Option<&str>) -> Result<Pool, CommandError> {
        let database = match (&self.pool, database) {
            (Pool::Postgres(_) | Pool::Mssql(_), Some(name))
                if !name.is_empty() && name != self.database =>
            {
                name
            }
            _ => return Ok(self.pool.clone()),
        };
        let off = || {
            invalid(
                "This connection only shows its own database. Turn on “Show all databases” to use others.",
            )
        };
        let open = async {
            match (&self.pool, &self.pg_options) {
                // Browsing and the odd query: fewer connections than a main pool, per database
                (Pool::Postgres(_), Some(options)) => pool_options()
                    .max_connections(OTHER_DATABASE_CONNECTIONS)
                    .connect_with(options.clone().database(database))
                    .await
                    .map(Pool::Postgres)
                    .map_err(connect_failed),
                (Pool::Mssql(main), _) if self.show_all => {
                    Ok(Pool::Mssql(main.sibling(database).await?))
                }
                _ => Err(off()),
            }
        };
        self.other(database, open).await
    }

    /// Closes the main pool and every other database's pool.
    pub(crate) async fn close(self) {
        let others: Vec<Pool> = self.others().drain().map(|(_, pool)| pool).collect();
        for pool in others {
            pool.close().await;
        }
        self.pool.close().await;
    }
}

/// Open connections, keyed by saved connection id.
#[derive(Default)]
pub struct Connections {
    // std Mutex, not tokio's: it is only held to insert/clone/remove, never across an await.
    pools: Mutex<HashMap<String, Open>>,
}

impl Connections {
    fn pools(&self) -> std::sync::MutexGuard<'_, HashMap<String, Open>> {
        self.pools.lock().expect("connections lock poisoned")
    }

    pub(crate) fn get(&self, id: &str) -> Result<Open, CommandError> {
        self.pools().get(id).cloned().ok_or(CommandError::new(
            ErrorCode::NotConnected,
            "This connection is closed.",
        ))
    }

    pub(crate) fn is_open(&self, id: &str) -> bool {
        self.pools().contains_key(id)
    }

    /// Stores the pool unless one is already open for `id` (two connects racing, e.g. a UI
    /// reload); then the existing one stays and the new one comes back to be closed.
    pub(crate) fn insert(&self, id: String, open: Open) -> Option<Open> {
        match self.pools().entry(id) {
            Entry::Occupied(_) => Some(open),
            Entry::Vacant(slot) => {
                slot.insert(open);
                None
            }
        }
    }

    pub(crate) fn remove(&self, id: &str) -> Option<Open> {
        self.pools().remove(id)
    }
}

#[derive(Serialize, Type)]
pub struct Schema {
    name: String,
    tables: Vec<Table>,
    /// Stored procedures and functions, by name; none on SQLite
    routines: Vec<Routine>,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    name: String,
    /// A stored procedure; otherwise a function
    procedure: bool,
    /// Postgres: its argument types, which tell overloads apart and find its definition
    args: Option<String>,
}

/// schema, name, procedure, Postgres arguments
type RoutineRow = (String, String, Option<bool>, Option<String>);

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    name: String,
    view: bool,
    /// Table plus its indexes, in bytes; None for views and on SQLite (needs the optional dbstat)
    #[specta(type = Option<specta_typescript::Number>)]
    size_bytes: Option<i64>,
}

type SchemaRow = (String, Option<String>, Option<bool>, Option<i64>);

/// One column of a table or view, for the editor's and the filter box's autocomplete.
#[derive(Serialize, Type, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    schema: String,
    table: String,
    name: String,
    type_name: String,
}

impl From<(String, String, String, String)> for ColumnInfo {
    fn from((schema, table, name, type_name): (String, String, String, String)) -> Self {
        Self {
            schema,
            table,
            name,
            type_name,
        }
    }
}

/// Typed error for the UI: a stable `code` to branch on and a message safe to show.
/// sqlx's messages never include the password or a connection string.
#[derive(Debug, Serialize, Type)]
pub struct CommandError {
    code: ErrorCode,
    message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidInput,
    NotConnected,
    ConnectFailed,
    QueryFailed,
    /// Writing the saved-connections file failed.
    SaveFailed,
    /// Reading or writing a password in the OS credential store failed.
    CredentialFailed,
    /// Reading the audit log failed. Writing it never fails a command (see audit.rs).
    AuditFailed,
    // Local databases (local/). Each message says what happened and what to do next.
    /// The Docker CLI isn't installed.
    DockerUnavailable,
    /// Docker is installed but its daemon (Docker Desktop, dockerd) isn't running.
    DockerStopped,
    /// The Docker daemon refused this user (Linux: not in the docker group).
    DockerPermission,
    /// Pulling the image failed: offline, registry unreachable, or the tag is gone.
    ImagePullFailed,
    PortInUse,
    DiskFull,
    /// The OS or a package manager refused (elevation declined, access denied).
    PermissionDenied,
    /// The server didn't pass its health check in time.
    StartupTimeout,
    InvalidCredentials,
    /// The container exited while QluePrint was waiting for it.
    ContainerStopped,
    SampleDataFailed,
    /// Provisioning was cancelled by the user.
    Cancelled,
    /// The container or volume isn't one QluePrint created, so it isn't touched.
    NotManaged,
    /// Not possible on this OS or with this package manager; the message has the manual steps.
    NativeUnsupported,
    /// A Docker or package-manager command failed for another reason.
    ProvisionFailed,
}

impl CommandError {
    pub(crate) fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn message(&self) -> &str {
        &self.message
    }

    pub(crate) fn code(&self) -> ErrorCode {
        self.code
    }
}

pub(crate) fn connect_failed(e: sqlx::Error) -> CommandError {
    // 28P01/28000: Postgres authentication failed; 1045/1698: MySQL access denied
    if let sqlx::Error::Database(db) = &e
        && matches!(
            db.code().as_deref(),
            Some("28P01" | "28000" | "1045" | "1698")
        )
    {
        return CommandError::new(
            ErrorCode::InvalidCredentials,
            format!("{e}. Check the user and password."),
        );
    }
    CommandError::new(ErrorCode::ConnectFailed, e.to_string())
}

pub(crate) fn query_failed(e: sqlx::Error) -> CommandError {
    CommandError::new(ErrorCode::QueryFailed, e.to_string())
}

pub(crate) fn invalid(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorCode::InvalidInput, message)
}

pub(crate) fn require(value: &str, field: &str) -> Result<(), CommandError> {
    if value.trim().is_empty() {
        return Err(invalid(format!("{field} is required.")));
    }
    Ok(())
}

fn pool_options<DB: sqlx::Database>() -> PoolOptions<DB> {
    PoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .acquire_timeout(CONNECT_TIMEOUT)
}

/// One direct connection attempt before the pool opens. The pool retries a failing connect until
/// its wait runs out and then reports only "pool timed out", hiding why (refused, TLS, DNS, auth);
/// a single attempt surfaces the real error, and a hang becomes a plain "couldn't reach" message.
async fn probe<C: sqlx::Connection>(
    options: &C::Options,
    server: &Server,
) -> Result<(), CommandError> {
    match tokio::time::timeout(CONNECT_TIMEOUT, C::connect_with(options)).await {
        Ok(Ok(connection)) => {
            let _ = connection.close().await;
            Ok(())
        }
        Ok(Err(e)) => Err(connect_failed(e)),
        Err(_) => Err(unreachable(&format!("{}:{}", server.host, server.port))),
    }
}

/// A connect to `address` (host:port) that hung for the whole `CONNECT_TIMEOUT`.
pub(crate) fn unreachable(address: &str) -> CommandError {
    CommandError::new(
        ErrorCode::ConnectFailed,
        format!(
            "Couldn’t reach {address} within {} seconds. Check the host and port, and whether a VPN, firewall or the server’s IP allow-list is blocking this machine.",
            CONNECT_TIMEOUT.as_secs()
        ),
    )
}

fn require_server(server: &Server) -> Result<(), CommandError> {
    require(&server.host, "Host")?;
    require(&server.user, "User")
}

/// Opens a pool for the request. Doesn't register it; see `Connections::insert`.
pub(crate) async fn open(request: ConnectRequest) -> Result<Open, CommandError> {
    // connect_with opens one connection up front, so bad credentials fail here, not on first use.
    let open = match request {
        ConnectRequest::Postgres(ServerLogin { server, password }) => {
            require_server(&server)?;
            let mut options = PgConnectOptions::new()
                .host(&server.host)
                .port(server.port)
                .username(&server.user)
                .password(&password)
                .application_name("QluePrint")
                .ssl_mode(server.ssl_mode.postgres());
            if !server.ssl_ca.is_empty() {
                options = options.ssl_root_cert(&server.ssl_ca);
            }
            if !server.database.is_empty() {
                options = options.database(&server.database);
            }
            probe::<sqlx::PgConnection>(&options, &server).await?;
            let pool = pool_options()
                .connect_with(options.clone())
                .await
                .map_err(connect_failed)?;
            // With none saved, Postgres picks one; the explorer and pickers need its name
            let database = if server.database.is_empty() {
                sqlx::query_scalar("SELECT current_database()::text")
                    .fetch_one(&pool)
                    .await
                    .map_err(connect_failed)?
            } else {
                server.database
            };
            let show_all = server.show_all_databases;
            Open::new(
                Pool::Postgres(pool),
                database,
                show_all,
                show_all.then_some(options),
            )
        }
        ConnectRequest::Mysql(ServerLogin { server, password }) => {
            require_server(&server)?;
            let mut options = MySqlConnectOptions::new()
                .host(&server.host)
                .port(server.port)
                .username(&server.user)
                .password(&password)
                .ssl_mode(server.ssl_mode.mysql());
            if !server.ssl_ca.is_empty() {
                options = options.ssl_ca(&server.ssl_ca);
            }
            if !server.database.is_empty() {
                options = options.database(&server.database);
            }
            probe::<sqlx::MySqlConnection>(&options, &server).await?;
            let pool = pool_options()
                .connect_with(options)
                .await
                .map_err(connect_failed)?;
            let show_all = server.show_all_databases;
            Open::new(Pool::Mysql(pool), server.database, show_all, None)
        }
        ConnectRequest::Mssql(MssqlLogin { server, password }) => {
            require(&server.host, "Host")?;
            if server.auth.needs_user() {
                require(&server.user, "User")?;
            }
            // The first connection is opened directly, so its error is the real one
            let (pool, database) = MssqlPool::open(&server, password).await?;
            Open::new(Pool::Mssql(pool), database, server.show_all_databases, None)
        }
        ConnectRequest::Sqlite { path } => {
            require(&path, "File")?;
            // create_if_missing stays false: a typo must not create an empty database file.
            let options = SqliteConnectOptions::new().filename(path);
            let pool = pool_options()
                .connect_with(options)
                .await
                .map_err(connect_failed)?;
            Open::sqlite(pool)
        }
    };
    Ok(open)
}

/// The databases on the server behind `pool`, without the system ones. SQLite has none.
async fn database_names(pool: &Pool) -> Result<Vec<String>, CommandError> {
    let names = match pool {
        Pool::Postgres(p) => sqlx::query_scalar(PG_DATABASES).fetch_all(p).await,
        Pool::Mysql(p) => sqlx::query_scalar(MYSQL_DATABASES).fetch_all(p).await,
        Pool::Mssql(p) => {
            let rows = mssql::catalog_rows(p, MSSQL_DATABASES, &[]).await?;
            return Ok(rows
                .into_iter()
                .map(|mut r| mssql::text(&mut r[0]))
                .collect());
        }
        Pool::Sqlite(_) => Ok(Vec::new()),
    };
    names.map_err(query_failed)
}

/// The databases on a server, for the connect dialog's picker, using a short-lived connection.
/// SQLite has no list (the file is the database), so it comes back empty.
#[tauri::command]
#[specta::specta]
pub async fn list_databases(mut request: ConnectRequest) -> Result<Vec<String>, CommandError> {
    // With no database named, Postgres connects to one named after the user, which often
    // doesn't exist; the `postgres` database always does.
    if let ConnectRequest::Postgres(login) = &mut request
        && login.server.database.is_empty()
    {
        login.server.database = "postgres".into();
    }
    let open = open(request).await?;
    let names = database_names(&open.pool).await;
    open.close().await;
    names
}

/// What the explorer and the toolbar's database picker show for an open connection.
#[derive(Serialize, Type)]
pub struct ConnectionDatabases {
    /// The database queries run in (see `Open::database`); MySQL with none saved starts in
    /// the first listed one.
    current: String,
    /// The databases the picker offers: the whole server or just `current` (see `Open::scope`).
    /// Empty for SQLite.
    listed: Vec<String>,
    /// Whether the picker can switch: MySQL always (USE), Postgres with "Show all databases"
    /// (a pool per database), SQLite never.
    switchable: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn connection_databases(
    id: String,
    connections: State<'_, Connections>,
) -> Result<ConnectionDatabases, CommandError> {
    let open = connections.get(&id)?;
    let listed = match (&open.pool, open.scope()) {
        (Pool::Sqlite(_), _) => Vec::new(),
        (_, Some(database)) => vec![database.to_owned()],
        (_, None) => database_names(&open.pool).await?,
    };
    let (current, switchable) = match &open.pool {
        Pool::Mysql(_) if open.database.is_empty() => {
            (listed.first().cloned().unwrap_or_default(), true)
        }
        Pool::Mysql(_) => (open.database.clone(), true),
        Pool::Postgres(_) | Pool::Mssql(_) => (open.database.clone(), open.show_all),
        Pool::Sqlite(_) => (open.database.clone(), false),
    };
    Ok(ConnectionDatabases {
        current,
        listed,
        switchable,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn disconnect(
    id: String,
    connections: State<'_, Connections>,
    saved: State<'_, Saved>,
    audit: State<'_, Audit>,
) -> Result<(), CommandError> {
    // Close outside the lock: it waits for in-flight queries to finish.
    if let Some(open) = connections.remove(&id) {
        open.close().await;
        let details = saved.audit_details(&id).unwrap_or_default();
        audit
            .record(EventKind::ConnectionClosed, Some(&id), details)
            .await;
    }
    Ok(())
}

/// Every schema with its tables and views, sorted by name, in one round trip. `database`
/// (Postgres only) is another database on the same server; its pool opens on first use.
/// MySQL lists its databases as schemas: only the saved one unless "Show all databases" is on.
#[tauri::command]
#[specta::specta]
pub async fn list_schemas(
    id: String,
    database: Option<String>,
    connections: State<'_, Connections>,
) -> Result<Vec<Schema>, CommandError> {
    let open = connections.get(&id)?;
    match open.pool_for(database.as_deref()).await? {
        Pool::Postgres(pool) => {
            let (rows, routines) = tokio::join!(
                sqlx::query_as::<_, SchemaRow>(PG_SCHEMAS).fetch_all(&pool),
                sqlx::query_as::<_, RoutineRow>(PG_ROUTINES).fetch_all(&pool),
            );
            let mut schemas = group_by_schema(rows.map_err(query_failed)?);
            // Best effort: routines (PG 10 has no prokind) never keep the tables from showing
            add_routines(&mut schemas, routines.unwrap_or_default());
            Ok(schemas)
        }
        Pool::Mysql(pool) => {
            let query = match open.scope() {
                Some(database) => sqlx::query_as(MYSQL_SCHEMA).bind(database),
                None => sqlx::query_as(MYSQL_SCHEMAS),
            };
            let routines = match open.scope() {
                Some(database) => sqlx::query_as(MYSQL_ROUTINES_IN).bind(database),
                None => sqlx::query_as(MYSQL_ROUTINES),
            };
            let (rows, routines) = tokio::join!(query.fetch_all(&pool), routines.fetch_all(&pool));
            let mut schemas = group_by_schema(rows.map_err(query_failed)?);
            add_routines(&mut schemas, routines.unwrap_or_default());
            Ok(schemas)
        }
        Pool::Mssql(pool) => {
            // Both at once: the pool hands each its own connection
            let (rows, routines) = tokio::join!(
                mssql::catalog_rows(&pool, MSSQL_SCHEMAS, &[]),
                mssql::catalog_rows(&pool, MSSQL_ROUTINES, &[]),
            );
            let rows = rows?.into_iter().map(|mut r| {
                let size = mssql::int(&mut r[3]);
                let view = mssql::flag(&mut r[2]);
                let table = r[1].take();
                (mssql::text(&mut r[0]), table, view, size)
            });
            let mut schemas = group_by_schema(rows.collect());
            let routines = routines.unwrap_or_default().into_iter().map(|mut r| {
                let procedure = mssql::flag(&mut r[2]);
                (
                    mssql::text(&mut r[0]),
                    mssql::text(&mut r[1]),
                    procedure,
                    None,
                )
            });
            add_routines(&mut schemas, routines.collect());
            Ok(schemas)
        }
        Pool::Sqlite(pool) => {
            let tables: Vec<(String, bool)> = sqlx::query_as(SQLITE_TABLES)
                .fetch_all(&pool)
                .await
                .map_err(query_failed)?;
            let tables = tables
                .into_iter()
                .map(|(name, view)| Table {
                    name,
                    view,
                    size_bytes: None,
                })
                .collect();
            Ok(vec![Schema {
                name: "main".into(),
                tables,
                routines: Vec::new(),
            }])
        }
    }
}

/// Every column of every table in `database` (Postgres: that database's pool; MySQL: that
/// database, else the saved one, else all user databases; SQLite: the file), in one round trip.
/// Metadata only, never row data, so it isn't audited.
#[tauri::command]
#[specta::specta]
pub async fn list_columns(
    id: String,
    database: Option<String>,
    connections: State<'_, Connections>,
) -> Result<Vec<ColumnInfo>, CommandError> {
    let open = connections.get(&id)?;
    let rows: Vec<(String, String, String, String)> =
        match open.pool_for(database.as_deref()).await? {
            Pool::Postgres(pool) => sqlx::query_as(PG_COLUMNS).fetch_all(&pool).await,
            Pool::Mysql(pool) => match database
                .as_deref()
                .filter(|d| !d.is_empty())
                .or(open.scope())
            {
                Some(database) => {
                    sqlx::query_as(MYSQL_COLUMNS)
                        .bind(database)
                        .fetch_all(&pool)
                        .await
                }
                None => sqlx::query_as(MYSQL_ALL_COLUMNS).fetch_all(&pool).await,
            },
            Pool::Mssql(pool) => {
                let rows = mssql::catalog_rows(&pool, MSSQL_COLUMNS, &[]).await?;
                return Ok(rows
                    .into_iter()
                    .map(|mut r| {
                        ColumnInfo::from((
                            mssql::text(&mut r[0]),
                            mssql::text(&mut r[1]),
                            mssql::text(&mut r[2]),
                            mssql::text(&mut r[3]),
                        ))
                    })
                    .collect());
            }
            Pool::Sqlite(pool) => sqlx::query_as(SQLITE_COLUMNS).fetch_all(&pool).await,
        }
        .map_err(query_failed)?;
    Ok(rows.into_iter().map(ColumnInfo::from).collect())
}

/// Folds rows already sorted by schema into nested schemas.
/// O(n) time, no extra space beyond the output; each String is moved, never cloned.
/// A row with no table is an empty schema (from the LEFT JOIN).
/// Files each routine under its schema; one in a schema the list doesn't have is dropped. O(rows).
fn add_routines(schemas: &mut [Schema], rows: Vec<RoutineRow>) {
    let at: HashMap<String, usize> = schemas
        .iter()
        .enumerate()
        .map(|(i, s)| (s.name.clone(), i))
        .collect();
    for (schema, name, procedure, args) in rows {
        if let Some(&i) = at.get(&schema) {
            schemas[i].routines.push(Routine {
                name,
                procedure: procedure.unwrap_or(false),
                args,
            });
        }
    }
}

fn group_by_schema(rows: Vec<SchemaRow>) -> Vec<Schema> {
    let mut schemas: Vec<Schema> = Vec::new();
    for (schema, table, view, size_bytes) in rows {
        if schemas.last().is_none_or(|s| s.name != schema) {
            schemas.push(Schema {
                name: schema,
                tables: Vec::new(),
                routines: Vec::new(),
            });
        }
        if let Some(name) = table {
            let last = schemas.last_mut().expect("pushed above");
            last.tables.push(Table {
                name,
                view: view.unwrap_or(false),
                size_bytes,
            });
        }
    }
    schemas
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_routines_under_their_schemas() {
        let row = |s: &str, t: &str| (s.to_string(), Some(t.to_string()), Some(false), None);
        let mut schemas = group_by_schema(vec![row("dbo", "orders"), row("sales", "items")]);
        let routine =
            |s: &str, n: &str, p, a: Option<&str>| (s.into(), n.into(), p, a.map(String::from));
        add_routines(
            &mut schemas,
            vec![
                routine("dbo", "usp_load", Some(true), None),
                routine("sales", "total", Some(false), Some("integer")),
                routine("sales", "total", Some(false), Some("integer, date")),
                // A schema the list doesn't have is dropped
                routine("gone", "f", Some(false), None),
            ],
        );
        let names = |i: usize| -> Vec<(String, bool, Option<String>)> {
            schemas[i]
                .routines
                .iter()
                .map(|r| (r.name.clone(), r.procedure, r.args.clone()))
                .collect()
        };
        assert_eq!(names(0), [("usp_load".to_string(), true, None)]);
        assert_eq!(
            names(1),
            [
                ("total".to_string(), false, Some("integer".to_string())),
                (
                    "total".to_string(),
                    false,
                    Some("integer, date".to_string())
                ),
            ]
        );
    }

    #[test]
    fn groups_sorted_rows_and_keeps_empty_schemas() {
        let row = |s: &str, t: Option<&str>, v, b| (s.to_string(), t.map(String::from), v, b);
        let schemas = group_by_schema(vec![
            row("empty", None, None, None),
            row("public", Some("orders"), Some(false), Some(8192)),
            row("public", Some("totals"), Some(true), None),
        ]);
        assert_eq!(schemas.len(), 2);
        assert!(schemas[0].tables.is_empty());
        let names: Vec<_> = schemas[1]
            .tables
            .iter()
            .map(|t| (t.name.as_str(), t.view, t.size_bytes))
            .collect();
        assert_eq!(
            names,
            [("orders", false, Some(8192)), ("totals", true, None)]
        );
    }

    #[tokio::test]
    async fn scopes_to_the_saved_database_unless_show_all() {
        let open = |database: &str, show_all| {
            let database = database.to_owned();
            async move {
                let pool = Pool::Sqlite(SqlitePool::connect("sqlite::memory:").await.unwrap());
                Open::new(pool, database, show_all, None)
            }
        };
        assert_eq!(open("shop", false).await.scope(), Some("shop"));
        assert_eq!(open("shop", true).await.scope(), None);
        assert_eq!(open("", false).await.scope(), None);
    }

    #[tokio::test]
    async fn lists_sqlite_tables_and_views() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE b (x); CREATE TABLE a (x); CREATE VIEW v AS SELECT 1")
            .execute(&pool)
            .await
            .unwrap();
        let connections = Connections::default();
        connections.insert("test".into(), Open::sqlite(pool));
        // Calls the query path directly; State can't be built outside a running app.
        let Pool::Sqlite(pool) = connections.get("test").unwrap().pool else {
            unreachable!()
        };
        let rows: Vec<(String, bool)> = sqlx::query_as(SQLITE_TABLES)
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(
            rows,
            [("a".into(), false), ("b".into(), false), ("v".into(), true)]
        );
    }

    #[tokio::test]
    async fn lists_sqlite_columns_in_table_order() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE t (id INTEGER, name TEXT); CREATE VIEW v AS SELECT name FROM t")
            .execute(&pool)
            .await
            .unwrap();
        let rows: Vec<(String, String, String, String)> = sqlx::query_as(SQLITE_COLUMNS)
            .fetch_all(&pool)
            .await
            .unwrap();
        let columns: Vec<ColumnInfo> = rows.into_iter().map(ColumnInfo::from).collect();
        let names: Vec<_> = columns
            .iter()
            .map(|c| (c.table.as_str(), c.name.as_str(), c.type_name.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                ("t", "id", "INTEGER"),
                ("t", "name", "TEXT"),
                ("v", "name", "TEXT")
            ]
        );
    }
}
