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
use sqlx::mysql::{MySqlConnectOptions, MySqlPool};
use sqlx::pool::PoolOptions;
use sqlx::postgres::{PgConnectOptions, PgPool};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
use tauri::State;

use crate::audit::{Audit, EventKind};
use crate::saved::Saved;

// Fail fast on an unreachable host instead of sqlx's 30s default.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
// A desktop client needs few connections: explorer + a couple of query tabs.
const MAX_CONNECTIONS: u32 = 4;
// Pools for a Postgres connection's other databases ("Show all databases").
const OTHER_DATABASE_CONNECTIONS: u32 = 2;

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
macro_rules! mysql_schemas {
    ($filter:expr) => {
        concat!(
            "SELECT s.SCHEMA_NAME, t.TABLE_NAME, t.TABLE_TYPE = 'VIEW'
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

// shortcut: only the "main" database, also list ATTACHed ones once the UI can attach.
const SQLITE_TABLES: &str = r"
    SELECT name, type = 'view' FROM sqlite_schema
    WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
    ORDER BY name";

/// Where a network database server is and who to sign in as.
#[derive(Clone, Serialize, Deserialize, Type)]
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

/// An open connection: its pool, plus what the explorer and the database pickers need.
#[derive(Clone)]
pub(crate) struct Open {
    pub(crate) pool: Pool,
    /// The database the pool is connected to: Postgres' actual one (even when the saved
    /// database was empty), MySQL's saved one (may be empty), `main` for SQLite.
    database: String,
    show_all: bool,
    /// Postgres with `show_all` only: the login, to open other databases on the same server.
    pg_options: Option<PgConnectOptions>,
    /// Postgres pools for those other databases, opened on first use. Shared by every clone.
    others: Arc<Mutex<HashMap<String, PgPool>>>,
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

    fn others(&self) -> std::sync::MutexGuard<'_, HashMap<String, PgPool>> {
        self.others.lock().expect("database pools lock poisoned")
    }

    /// The Postgres pool for `database`: the main one for its own database (or none given),
    /// otherwise one per database, opened with the same login the first time it's asked for.
    pub(crate) async fn pg_pool(&self, database: Option<&str>) -> Result<PgPool, CommandError> {
        let Pool::Postgres(main) = &self.pool else {
            return Err(CommandError::new(
                ErrorCode::InvalidInput,
                "Not a PostgreSQL connection.",
            ));
        };
        let database = match database {
            Some(name) if !name.is_empty() && name != self.database => name,
            _ => return Ok(main.clone()),
        };
        if let Some(pool) = self.others().get(database) {
            return Ok(pool.clone());
        }
        let Some(options) = &self.pg_options else {
            return Err(CommandError::new(
                ErrorCode::InvalidInput,
                "This connection only shows its own database. Turn on “Show all databases” to use others.",
            ));
        };
        // Browsing and the odd query: fewer connections than a main pool, per database
        let pool = pool_options()
            .max_connections(OTHER_DATABASE_CONNECTIONS)
            .connect_with(options.clone().database(database))
            .await
            .map_err(connect_failed)?;
        // Two requests can race to open the same database; the first one stored wins
        let existing = match self.others().entry(database.to_owned()) {
            Entry::Occupied(slot) => slot.get().clone(),
            Entry::Vacant(slot) => return Ok(slot.insert(pool).clone()),
        };
        pool.close().await;
        Ok(existing)
    }

    /// Closes the main pool and every other database's pool.
    pub(crate) async fn close(self) {
        let others: Vec<PgPool> = self.others().drain().map(|(_, pool)| pool).collect();
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
    /// Reading the audit log failed. Writing it never fails a command (see audit.rs).
    AuditFailed,
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
}

pub(crate) fn connect_failed(e: sqlx::Error) -> CommandError {
    CommandError::new(ErrorCode::ConnectFailed, e.to_string())
}

pub(crate) fn query_failed(e: sqlx::Error) -> CommandError {
    CommandError::new(ErrorCode::QueryFailed, e.to_string())
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
                .application_name("QueryCraft");
            if !server.database.is_empty() {
                options = options.database(&server.database);
            }
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
                .password(&password);
            if !server.database.is_empty() {
                options = options.database(&server.database);
            }
            let pool = pool_options()
                .connect_with(options)
                .await
                .map_err(connect_failed)?;
            let show_all = server.show_all_databases;
            Open::new(Pool::Mysql(pool), server.database, show_all, None)
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
        Pool::Postgres(_) => (open.database.clone(), open.show_all),
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
    match &open.pool {
        Pool::Postgres(_) => {
            let pool = open.pg_pool(database.as_deref()).await?;
            let rows: Vec<(String, Option<String>, Option<bool>)> = sqlx::query_as(PG_SCHEMAS)
                .fetch_all(&pool)
                .await
                .map_err(query_failed)?;
            Ok(group_by_schema(rows))
        }
        Pool::Mysql(pool) => {
            let query = match open.scope() {
                Some(database) => sqlx::query_as(MYSQL_SCHEMA).bind(database),
                None => sqlx::query_as(MYSQL_SCHEMAS),
            };
            let rows: Vec<(String, Option<String>, Option<bool>)> =
                query.fetch_all(pool).await.map_err(query_failed)?;
            Ok(group_by_schema(rows))
        }
        Pool::Sqlite(pool) => {
            let tables: Vec<(String, bool)> = sqlx::query_as(SQLITE_TABLES)
                .fetch_all(pool)
                .await
                .map_err(query_failed)?;
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
}
