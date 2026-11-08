//! Open database connections and read their schema tree.
//!
//! Pools are keyed by the saved connection's id, so the UI and Rust share one id space and a
//! reloaded UI finds its pools still open. The passwords inside them never leave Rust.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool};
use sqlx::pool::PoolOptions;
use sqlx::postgres::{PgConnectOptions, PgPool};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
use tauri::State;

// Fail fast on an unreachable host instead of sqlx's 30s default.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
// A desktop client needs few connections: explorer + a couple of query tabs.
const MAX_CONNECTIONS: u32 = 4;

// pg_catalog, not information_schema: the latter runs a privilege check per row and is much
// slower on big catalogs. LEFT JOIN keeps empty schemas; partitions are hidden (their parent is
// listed); pg_* and information_schema are system schemas.
const PG_SCHEMAS: &str = r"
    SELECT n.nspname::text, c.relname::text, c.relkind IN ('v', 'm')
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
// only in case.
const MYSQL_SCHEMAS: &str = concat!(
    "SELECT s.SCHEMA_NAME, t.TABLE_NAME, t.TABLE_TYPE = 'VIEW'
    FROM information_schema.SCHEMATA s
    LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
    WHERE s.",
    mysql_user_databases!(),
    " ORDER BY CAST(s.SCHEMA_NAME AS BINARY), t.TABLE_NAME"
);

const MYSQL_DATABASES: &str = concat!(
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE ",
    mysql_user_databases!(),
    " ORDER BY SCHEMA_NAME"
);

// Template databases can't be queried, and datallowconn = false ones refuse connections.
const PG_DATABASES: &str = "SELECT datname::text FROM pg_catalog.pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1";

// shortcut: only the "main" database, also list ATTACHed ones once the UI can attach.
const SQLITE_TABLES: &str = r"
    SELECT name, type = 'view' FROM sqlite_schema
    WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
    ORDER BY name";

/// Where a network database server is and who to sign in as.
#[derive(Clone, Serialize, Deserialize, Type)]
pub struct Server {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Empty means the server's default: for Postgres a database named after the user, for
    /// MySQL none (queries then name the database, as in `shop.orders`).
    pub database: String,
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
    Sqlite { path: String },
}

// Every pool type is an Arc inside, so cloning one out of the map is O(1).
#[derive(Clone)]
pub(crate) enum Pool {
    Postgres(PgPool),
    Mysql(MySqlPool),
    Sqlite(SqlitePool),
}

impl Pool {
    pub(crate) async fn close(self) {
        match self {
            Pool::Postgres(p) => p.close().await,
            Pool::Mysql(p) => p.close().await,
            Pool::Sqlite(p) => p.close().await,
        }
    }
}

/// Open pools, keyed by saved connection id.
#[derive(Default)]
pub struct Connections {
    // std Mutex, not tokio's: it is only held to insert/clone/remove, never across an await.
    pools: Mutex<HashMap<String, Pool>>,
}

impl Connections {
    fn pools(&self) -> std::sync::MutexGuard<'_, HashMap<String, Pool>> {
        self.pools.lock().expect("connections lock poisoned")
    }

    pub(crate) fn get(&self, id: &str) -> Result<Pool, CommandError> {
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
    pub(crate) fn insert(&self, id: String, pool: Pool) -> Option<Pool> {
        match self.pools().entry(id) {
            std::collections::hash_map::Entry::Occupied(_) => Some(pool),
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(pool);
                None
            }
        }
    }

    pub(crate) fn remove(&self, id: &str) -> Option<Pool> {
        self.pools().remove(id)
    }
}

#[derive(Serialize, Type)]
pub struct Schema {
    name: String,
    tables: Vec<Table>,
}

#[derive(Serialize, Type)]
pub struct Table {
    name: String,
    view: bool,
}

/// Typed error for the UI: a stable `code` to branch on and a message safe to show.
/// sqlx's messages never include the password or a connection string.
#[derive(Debug, Serialize, Type)]
pub struct CommandError {
    code: ErrorCode,
    message: String,
}

#[derive(Debug, Serialize, Type)]
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
}

impl CommandError {
    pub(crate) fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub(crate) fn require(value: &str, field: &str) -> Result<(), CommandError> {
    if value.trim().is_empty() {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            format!("{field} is required."),
        ));
    }
    Ok(())
}

fn pool_options<DB: sqlx::Database>() -> PoolOptions<DB> {
    PoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .acquire_timeout(CONNECT_TIMEOUT)
}

fn require_server(server: &Server) -> Result<(), CommandError> {
    require(&server.host, "Host")?;
    require(&server.user, "User")
}

/// Opens a pool for the request. Doesn't register it; see `Connections::insert`.
pub(crate) async fn open(request: ConnectRequest) -> Result<Pool, CommandError> {
    let failed = |e: sqlx::Error| CommandError::new(ErrorCode::ConnectFailed, e.to_string());

    // connect_with opens one connection up front, so bad credentials fail here, not on first use.
    let pool = match request {
        ConnectRequest::Postgres(ServerLogin { server, password }) => {
            require_server(&server)?;
            let mut options = PgConnectOptions::new()
                .host(&server.host)
                .port(server.port)
                .username(&server.user)
                .password(&password)
                .application_name("QueryCraft");
            if !server.database.is_empty() {
                options = options.database(&server.database);
            }
            Pool::Postgres(pool_options().connect_with(options).await.map_err(failed)?)
        }
        ConnectRequest::Mysql(ServerLogin { server, password }) => {
            require_server(&server)?;
            let mut options = MySqlConnectOptions::new()
                .host(&server.host)
                .port(server.port)
                .username(&server.user)
                .password(&password);
            if !server.database.is_empty() {
                options = options.database(&server.database);
            }
            Pool::Mysql(pool_options().connect_with(options).await.map_err(failed)?)
        }
        ConnectRequest::Sqlite { path } => {
            require(&path, "File")?;
            // create_if_missing stays false: a typo must not create an empty database file.
            let options = SqliteConnectOptions::new().filename(path);
            Pool::Sqlite(pool_options().connect_with(options).await.map_err(failed)?)
        }
    };
    Ok(pool)
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
    let pool = open(request).await?;
    let databases = match &pool {
        Pool::Postgres(p) => sqlx::query_scalar(PG_DATABASES).fetch_all(p).await,
        Pool::Mysql(p) => sqlx::query_scalar(MYSQL_DATABASES).fetch_all(p).await,
        Pool::Sqlite(_) => Ok(Vec::new()),
    };
    pool.close().await;
    databases.map_err(|e| CommandError::new(ErrorCode::QueryFailed, e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn disconnect(
    id: String,
    connections: State<'_, Connections>,
) -> Result<(), CommandError> {
    // Close outside the lock: it waits for in-flight queries to finish.
    if let Some(pool) = connections.remove(&id) {
        pool.close().await;
    }
    Ok(())
}

/// Every schema with its tables and views, sorted by name, in one round trip.
#[tauri::command]
#[specta::specta]
pub async fn list_schemas(
    id: String,
    connections: State<'_, Connections>,
) -> Result<Vec<Schema>, CommandError> {
    let failed = |e: sqlx::Error| CommandError::new(ErrorCode::QueryFailed, e.to_string());

    match connections.get(&id)? {
        Pool::Postgres(pool) => {
            let rows: Vec<(String, Option<String>, Option<bool>)> = sqlx::query_as(PG_SCHEMAS)
                .fetch_all(&pool)
                .await
                .map_err(failed)?;
            Ok(group_by_schema(rows))
        }
        Pool::Mysql(pool) => {
            let rows: Vec<(String, Option<String>, Option<bool>)> = sqlx::query_as(MYSQL_SCHEMAS)
                .fetch_all(&pool)
                .await
                .map_err(failed)?;
            Ok(group_by_schema(rows))
        }
        Pool::Sqlite(pool) => {
            let tables: Vec<(String, bool)> = sqlx::query_as(SQLITE_TABLES)
                .fetch_all(&pool)
                .await
                .map_err(failed)?;
            let tables = tables
                .into_iter()
                .map(|(name, view)| Table { name, view })
                .collect();
            Ok(vec![Schema {
                name: "main".into(),
                tables,
            }])
        }
    }
}

/// Folds rows already sorted by schema into nested schemas.
/// O(n) time, no extra space beyond the output; each String is moved, never cloned.
/// A row with no table is an empty schema (from the LEFT JOIN).
fn group_by_schema(rows: Vec<(String, Option<String>, Option<bool>)>) -> Vec<Schema> {
    let mut schemas: Vec<Schema> = Vec::new();
    for (schema, table, view) in rows {
        if schemas.last().is_none_or(|s| s.name != schema) {
            schemas.push(Schema {
                name: schema,
                tables: Vec::new(),
            });
        }
        if let Some(name) = table {
            let last = schemas.last_mut().expect("pushed above");
            last.tables.push(Table {
                name,
                view: view.unwrap_or(false),
            });
        }
    }
    schemas
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_sorted_rows_and_keeps_empty_schemas() {
        let row = |s: &str, t: Option<&str>, v| (s.to_string(), t.map(String::from), v);
        let schemas = group_by_schema(vec![
            row("empty", None, None),
            row("public", Some("orders"), Some(false)),
            row("public", Some("totals"), Some(true)),
        ]);
        assert_eq!(schemas.len(), 2);
        assert!(schemas[0].tables.is_empty());
        let names: Vec<_> = schemas[1]
            .tables
            .iter()
            .map(|t| (t.name.as_str(), t.view))
            .collect();
        assert_eq!(names, [("orders", false), ("totals", true)]);
    }

    #[tokio::test]
    async fn lists_sqlite_tables_and_views() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE b (x); CREATE TABLE a (x); CREATE VIEW v AS SELECT 1")
            .execute(&pool)
            .await
            .unwrap();
        let connections = Connections::default();
        connections.insert("test".into(), Pool::Sqlite(pool));
        // Calls the query path directly; State can't be built outside a running app.
        let Pool::Sqlite(pool) = connections.get("test").unwrap() else {
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
}
