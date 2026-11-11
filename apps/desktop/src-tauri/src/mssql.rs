//! SQL Server and Azure SQL through tiberius (sqlx has no TDS driver): settings, a small
//! connection pool, the query runner and how its values read as text.
//!
//! Each pool is bound to one database. A user's SQL may `USE` another one, so a connection it ran
//! on switches back before anyone else borrows it. Azure SQL can't switch databases at all, which
//! is why another database gets its own pool (see `Open::mssql_pool`), as on Postgres.

use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use specta::Type;
use tiberius::{
    AuthMethod, Client, ColumnData, ColumnType, Config, EncryptionLevel, QueryItem, SqlBrowser,
    ToSql,
};
use tokio::net::TcpStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::db::{CONNECT_TIMEOUT, CommandError, ErrorCode, MAX_CONNECTIONS, unreachable};
use crate::entra::TokenSource;
use crate::query::{ColumnKind, QueryOutput, ResultColumn, hex_text};

/// How a SQL Server connection signs in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum MssqlAuth {
    /// A SQL Server login: user and password.
    SqlLogin,
    /// Microsoft Entra ID in the system browser (authorization code + PKCE), MFA included.
    EntraInteractive,
    /// The token `az account get-access-token` prints.
    AzureCli,
    /// The Azure host's managed identity (instance metadata service).
    ManagedIdentity,
    /// Microsoft Entra user and password (ROPC). Deprecated by Microsoft; fails when MFA is enforced.
    EntraPassword,
}

impl MssqlAuth {
    /// Whether the sign-in needs a user name typed in.
    pub(crate) fn needs_user(self) -> bool {
        matches!(self, Self::SqlLogin | Self::EntraPassword)
    }
}

/// Where a SQL Server is and how to sign in. The password, or Entra's refresh token, lives in the
/// OS credential store like every other engine's password.
#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MssqlServer {
    pub host: String,
    pub port: u16,
    /// A named instance (`host\SQLEXPRESS`), found through the SQL Server Browser when the port is
    /// 1433 (otherwise the port is the instance's). Empty: none.
    #[serde(default)]
    pub instance: String,
    /// The SQL login or Entra account; for interactive sign-in, the account that signed in.
    /// Empty for Azure CLI and managed identity, which sign in as themselves.
    pub user: String,
    /// Empty means the login's default database.
    pub database: String,
    pub auth: MssqlAuth,
    /// Encrypt everything, not just the login.
    pub encrypt: bool,
    /// Accept any certificate, without checking who issued it or the host name in it.
    pub trust_server_certificate: bool,
    /// Entra tenant. Empty: the one the server names for Entra MFA (`entra::Authority`),
    /// `organizations` (any work or school account) for an Entra password.
    #[serde(default)]
    pub tenant_id: String,
    /// Entra app (client) ID instead of QueryCraft's own; for managed identity, a user-assigned
    /// identity's client ID. Empty: the default.
    #[serde(default)]
    pub client_id: String,
    /// See `db::Server::show_all_databases`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub show_all_databases: bool,
}

impl MssqlServer {
    /// `host`, or `host\instance` for a named instance.
    pub(crate) fn address(&self) -> String {
        match self.instance.trim() {
            "" => self.host.clone(),
            instance => format!("{}\\{instance}", self.host),
        }
    }
}

#[derive(Deserialize, Type)]
pub struct MssqlLogin {
    #[serde(flatten)]
    pub server: MssqlServer,
    /// The password for a SQL login or Entra password; empty otherwise.
    pub password: String,
}

type Tds = Client<Compat<TcpStream>>;

/// A pooled connection unused this long is checked with a round trip before it's handed out:
/// Azure closes idle connections, and a laptop changes networks.
const STALE: Duration = Duration::from_secs(60);

enum Login {
    Sql { user: String, password: String },
    Entra(Arc<TokenSource>),
}

/// Everything needed to open another connection: the settings minus the database, and the sign-in.
struct Connector {
    config: Config,
    login: Login,
}

impl Connector {
    fn new(server: &MssqlServer, secret: String) -> Self {
        let mut config = Config::new();
        config.host(server.host.trim());
        // As in ADO.NET: a named instance on the default port is looked up through the SQL Server
        // Browser (UDP 1434); any other port is the instance's own and is used directly
        let instance = server.instance.trim();
        if instance.is_empty() || server.port != 1433 {
            config.port(server.port);
        } else {
            config.instance_name(instance);
        }
        config.application_name("QueryCraft");
        if server.encrypt {
            config.encryption(EncryptionLevel::Required);
            if server.trust_server_certificate {
                config.trust_cert();
            }
        } else {
            // Only the login is encrypted then, and like ADO.NET with Encrypt=false its
            // certificate isn't checked: otherwise every local server's self-signed one fails
            config.encryption(EncryptionLevel::Off);
            config.trust_cert();
        }
        let login = match TokenSource::new(server, &secret) {
            Some(source) => Login::Entra(Arc::new(source)),
            None => Login::Sql {
                user: server.user.trim().to_owned(),
                password: secret,
            },
        };
        Self { config, login }
    }

    async fn connect(&self, database: &str) -> Result<Tds, CommandError> {
        let mut config = self.config.clone();
        if !database.is_empty() {
            config.database(database);
        }
        if let Login::Entra(source) = &self.login
            && source.discovers()
            && let Some(client) = discover(source, config.clone()).await?
        {
            return Ok(client);
        }
        // A token can take a browser sign-in, so it's fetched outside the connect timeout
        config.authentication(match &self.login {
            Login::Sql { user, password } => AuthMethod::sql_server(user, password),
            Login::Entra(source) => AuthMethod::aad_token(source.token().await?),
        });
        connect(config).await
    }
}

/// Asks the server which Entra tenant it trusts, as Microsoft's drivers do: the login names the
/// ADAL workflow and the server's FEDAUTHINFO answers with the authority (kept by
/// `TokenSource::learn` for later connections). When a refresh token works there, this connection
/// signs in with it; None when only the browser can, which happens outside the connect timeout.
async fn discover(
    source: &Arc<TokenSource>,
    mut config: Config,
) -> Result<Option<Tds>, CommandError> {
    let needs_browser = Arc::new(AtomicBool::new(false));
    let (callback_source, flag) = (source.clone(), needs_browser.clone());
    // Called again after a gateway redirect; the token is cached by then
    config.authentication(AuthMethod::aad_interactive(move |info| {
        let (source, flag) = (callback_source.clone(), flag.clone());
        Box::pin(async move {
            let (sts_url, spn) = (
                info.sts_url.unwrap_or_default(),
                info.spn.unwrap_or_default(),
            );
            source
                .learn(&sts_url, &spn)
                .map_err(|e| tiberius::error::Error::Protocol(e.into()))?;
            match source.silent_token().await {
                Some(token) => Ok(token),
                None => {
                    flag.store(true, Ordering::Relaxed);
                    Err(tiberius::error::Error::Protocol(
                        "a browser sign-in is needed".into(),
                    ))
                }
            }
        })
    }));
    match connect(config).await {
        Ok(client) => Ok(Some(client)),
        Err(_) if needs_browser.load(Ordering::Relaxed) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Azure SQL's gateway may redirect the login to the node that holds the database: follow it once.
/// Gives up after `CONNECT_TIMEOUT`.
async fn connect(config: Config) -> Result<Tds, CommandError> {
    let host = config.get_addr();
    tokio::time::timeout(CONNECT_TIMEOUT, connect_routed(config))
        .await
        .map_err(|_| unreachable(&host))?
}

async fn connect_routed(mut config: Config) -> Result<Tds, CommandError> {
    for _ in 0..2 {
        let tcp = TcpStream::connect_named(&config)
            .await
            .map_err(connect_failed)?;
        let _ = tcp.set_nodelay(true);
        match Client::connect(config.clone(), tcp.compat_write()).await {
            Ok(client) => return Ok(client),
            Err(tiberius::error::Error::Routing { host, port }) => {
                config.host(host);
                config.port(port);
            }
            Err(e) => return Err(connect_failed(e)),
        }
    }
    Err(CommandError::new(
        ErrorCode::ConnectFailed,
        "The server redirected the connection more than once.",
    ))
}

pub(crate) fn connect_failed(e: tiberius::error::Error) -> CommandError {
    match &e {
        // Azure SQL refuses a token from another tenant than its own, e.g. a guest's home tenant
        tiberius::error::Error::Server(t)
            if t.code() == 18456
                && t.message()
                    .contains("not currently configured to accept this token") =>
        {
            CommandError::new(
                ErrorCode::InvalidCredentials,
                format!(
                    "{} The token came from a different Microsoft Entra tenant than the server's. Under Advanced, check Tenant ID: for Microsoft Entra MFA leave it empty and QueryCraft asks the server for its tenant; otherwise enter the server's tenant (for a guest account, that tenant, not your home one).",
                    t.message()
                ),
            )
        }
        // Login failed. With a token it means the account has no user in this database
        tiberius::error::Error::Server(t) if t.code() == 18456 => CommandError::new(
            ErrorCode::InvalidCredentials,
            format!(
                "{} Check the user and password, or that the account has a user in this database.",
                t.message()
            ),
        ),
        // Cannot open the database the login asked for
        tiberius::error::Error::Server(t) => {
            CommandError::new(ErrorCode::ConnectFailed, t.message().to_owned())
        }
        _ => CommandError::new(ErrorCode::ConnectFailed, e.to_string()),
    }
}

pub(crate) fn query_failed(e: tiberius::error::Error) -> CommandError {
    let message = match &e {
        tiberius::error::Error::Server(t) if t.line() > 0 => {
            format!("{} (line {})", t.message(), t.line())
        }
        tiberius::error::Error::Server(t) => t.message().to_owned(),
        _ => e.to_string(),
    };
    CommandError::new(ErrorCode::QueryFailed, message)
}

struct Conn {
    client: Tds,
    /// The user's SQL ran on it, so it may be in another database now
    dirty: bool,
    returned: Instant,
}

struct Inner {
    connector: Arc<Connector>,
    database: String,
    idle: Mutex<Vec<Conn>>,
    permits: Arc<Semaphore>,
}

/// Up to `MAX_CONNECTIONS` connections to one database, reused. Cloning is O(1).
// shortcut: no idle timeout or max lifetime, like a desktop session needs; add them if pools grow
#[derive(Clone)]
pub(crate) struct MssqlPool(Arc<Inner>);

/// A borrowed connection; it goes back to the pool when dropped, unless discarded.
pub(crate) struct Pooled {
    conn: Option<Conn>,
    pool: Arc<Inner>,
    _permit: OwnedSemaphorePermit,
}

impl Pooled {
    pub(crate) fn client(&mut self) -> &mut Tds {
        &mut self.conn.as_mut().expect("not discarded").client
    }

    /// Closes it instead of returning it: after an error its session state is unknown (an open
    /// transaction, SHOWPLAN left on).
    pub(crate) fn discard(&mut self) {
        self.conn = None;
    }

    /// Runs `work` on the connection, discarding it when that fails.
    async fn attempt<T>(
        &mut self,
        work: impl AsyncFnOnce(&mut Tds) -> Result<T, tiberius::error::Error>,
    ) -> Result<T, CommandError> {
        let result = work(self.client()).await;
        if result.is_err() {
            self.discard();
        }
        result.map_err(query_failed)
    }

    /// The user's SQL is about to run on it, so it may end up in another database.
    pub(crate) fn mark_dirty(&mut self) {
        self.conn.as_mut().expect("not discarded").dirty = true;
    }
}

impl Drop for Pooled {
    fn drop(&mut self) {
        if let Some(mut conn) = self.conn.take() {
            conn.returned = Instant::now();
            self.pool
                .idle
                .lock()
                .expect("pool lock poisoned")
                .push(conn);
        }
    }
}

impl MssqlPool {
    /// Opens the first connection (so bad settings fail here) and returns the pool with the
    /// database it's in: the saved one, or the login's default.
    pub(crate) async fn open(
        server: &MssqlServer,
        secret: String,
    ) -> Result<(Self, String), CommandError> {
        let connector = Arc::new(Connector::new(server, secret));
        let mut client = connector.connect(server.database.trim()).await?;
        let database = async {
            client
                .simple_query("SELECT DB_NAME()")
                .await?
                .into_row()
                .await
        }
        .await
        .map_err(connect_failed)?
        .and_then(|row| row.get::<&str, _>(0).map(str::to_owned))
        .unwrap_or_default();
        let pool = Self::with(connector, database.clone());
        pool.0.idle.lock().expect("pool lock poisoned").push(Conn {
            client,
            dirty: false,
            returned: Instant::now(),
        });
        Ok((pool, database))
    }

    fn with(connector: Arc<Connector>, database: String) -> Self {
        Self(Arc::new(Inner {
            connector,
            database,
            idle: Mutex::default(),
            permits: Arc::new(Semaphore::new(MAX_CONNECTIONS as usize)),
        }))
    }

    /// A pool for another database on the same server, with the same sign-in (and token).
    /// Checks the login can open it.
    pub(crate) async fn sibling(&self, database: &str) -> Result<Self, CommandError> {
        let pool = Self::with(self.0.connector.clone(), database.to_owned());
        drop(pool.get().await?);
        Ok(pool)
    }

    pub(crate) async fn get(&self) -> Result<Pooled, CommandError> {
        let permit = tokio::time::timeout(CONNECT_TIMEOUT, self.0.permits.clone().acquire_owned())
            .await
            .map_err(|_| {
                CommandError::new(
                    ErrorCode::QueryFailed,
                    "Every connection is busy with another query. Try again when one finishes.",
                )
            })?
            .expect("the semaphore is never closed");
        let idle = self.0.idle.lock().expect("pool lock poisoned").pop();
        let mut conn = match idle {
            Some(mut conn) if conn.returned.elapsed() > STALE => {
                let ping = async {
                    conn.client
                        .simple_query("SELECT 1")
                        .await?
                        .into_results()
                        .await
                };
                ping.await.is_ok().then_some(conn)
            }
            idle => idle,
        };
        if conn.is_none() {
            conn = Some(Conn {
                client: self.0.connector.connect(&self.0.database).await?,
                dirty: false,
                returned: Instant::now(),
            });
        }
        let mut pooled = Pooled {
            conn,
            pool: self.0.clone(),
            _permit: permit,
        };
        let conn = pooled.conn.as_mut().expect("set above");
        if conn.dirty && !self.0.database.is_empty() {
            let sql = format!("USE {}", quote(&self.0.database));
            pooled
                .attempt(async |client| client.simple_query(sql).await?.into_results().await)
                .await?;
            pooled.conn.as_mut().expect("kept on success").dirty = false;
        }
        Ok(pooled)
    }

    /// Runs `work` on a pooled connection (marked dirty first when it runs the user's SQL).
    async fn using<T>(
        &self,
        dirty: bool,
        work: impl AsyncFnOnce(&mut Tds) -> Result<T, tiberius::error::Error>,
    ) -> Result<T, CommandError> {
        let mut conn = self.get().await?;
        if dirty {
            conn.mark_dirty();
        }
        conn.attempt(work).await
    }

    pub(crate) async fn close(self) {
        let idle: Vec<Conn> = self
            .0
            .idle
            .lock()
            .expect("pool lock poisoned")
            .drain(..)
            .collect();
        for conn in idle {
            let _ = conn.client.close().await;
        }
    }
}

/// `[name]`, with any `]` inside doubled.
pub(crate) fn quote(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

/// The batches of a script: SSMS and sqlcmd end one at a line that is just `GO`. Blank ones are
/// dropped.
// shortcut: a line reading GO inside a /* comment */ or string splits too, as in SSMS without the parser; count GO's repeat argument if someone needs `GO 5`
pub(crate) fn batches(sql: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut at = 0;
    for line in sql.split_inclusive('\n') {
        if line.trim().eq_ignore_ascii_case("go") {
            out.push(&sql[start..at]);
            start = at + line.len();
        }
        at += line.len();
    }
    out.push(&sql[start..]);
    out.retain(|batch| !batch.trim().is_empty());
    out
}

/// Runs a script (several statements, or `GO`-separated batches) on one connection of `pool`.
/// The output is the last result set; when nothing returned one, the last statement's row count.
pub(crate) async fn run(
    pool: &MssqlPool,
    sql: &str,
    keep: usize,
) -> Result<QueryOutput, CommandError> {
    pool.using(true, async |client| run_batches(client, sql, keep).await)
        .await
}

async fn run_batches(
    client: &mut Tds,
    sql: &str,
    keep: usize,
) -> Result<QueryOutput, tiberius::error::Error> {
    let mut output: Option<QueryOutput> = None;
    for batch in batches(sql) {
        let mut stream = client.simple_query(batch).await?;
        while let Some(item) = stream.try_next().await? {
            match item {
                QueryItem::Metadata(meta) => {
                    output = Some(QueryOutput {
                        columns: meta.columns().iter().map(column).collect(),
                        ..Default::default()
                    });
                }
                QueryItem::Row(row) => {
                    let Some(output) = output.as_mut() else {
                        continue;
                    };
                    output.rows_affected += 1;
                    if output.rows.len() < keep {
                        output
                            .rows
                            .push(row.cells().map(|(_, value)| cell(value)).collect());
                    } else {
                        output.truncated = true;
                    }
                }
            }
        }
    }
    if let Some(output) = output {
        return Ok(output);
    }
    // TDS reports the count in a DONE token tiberius doesn't surface; the session still has it
    let count = client
        .simple_query("SELECT CAST(@@ROWCOUNT AS bigint)")
        .await?
        .into_row()
        .await?
        .and_then(|row| row.get::<i64, _>(0))
        .unwrap_or(0);
    Ok(QueryOutput {
        rows_affected: count.max(0) as u64,
        ..Default::default()
    })
}

/// Rows changed by one statement already sent on `client`'s session, counted by the server.
pub(crate) async fn execute_counted(
    client: &mut Tds,
    sql: &str,
) -> Result<u64, tiberius::error::Error> {
    let counted = format!("{sql};\nSELECT CAST(@@ROWCOUNT AS bigint)");
    let results = client.simple_query(counted).await?.into_results().await?;
    let count = results
        .last()
        .and_then(|rows| rows.first())
        .and_then(|row| row.get::<i64, _>(0))
        .unwrap_or(0);
    Ok(count.max(0) as u64)
}

/// Runs `sql` with `@P1…` bound to `params` and returns every result set's rows as text, the
/// way `cell` writes values.
pub(crate) async fn catalog(
    pool: &MssqlPool,
    sql: &str,
    params: &[&dyn ToSql],
) -> Result<Vec<Vec<Vec<Option<String>>>>, CommandError> {
    let results = pool
        .using(false, async |client| {
            client.query(sql, params).await?.into_results().await
        })
        .await?;
    Ok(results
        .iter()
        .map(|rows| {
            rows.iter()
                .map(|row| row.cells().map(|(_, value)| cell(value)).collect())
                .collect()
        })
        .collect())
}

/// A catalog cell as text, "" for NULL.
pub(crate) fn text(cell: &mut Option<String>) -> String {
    cell.take().unwrap_or_default()
}

/// A catalog cell as a whole number; None for NULL.
pub(crate) fn int(cell: &mut Option<String>) -> Option<i64> {
    cell.take().and_then(|n| n.parse().ok())
}

/// A catalog cell holding a bit; None for NULL.
pub(crate) fn flag(cell: &mut Option<String>) -> Option<bool> {
    cell.take().map(|v| v == "1")
}

/// The first result set of `catalog`.
pub(crate) async fn catalog_rows(
    pool: &MssqlPool,
    sql: &str,
    params: &[&dyn ToSql],
) -> Result<Vec<Vec<Option<String>>>, CommandError> {
    Ok(catalog(pool, sql, params)
        .await?
        .into_iter()
        .next()
        .unwrap_or_default())
}

fn column(c: &tiberius::Column) -> ResultColumn {
    let (type_name, kind) = column_type(c.column_type());
    ResultColumn {
        name: c.name().to_owned(),
        type_name: type_name.to_owned(),
        kind,
    }
}

/// TDS sends a type family, not the declared type (`Intn` is any int size), so names are the
/// family's closest SQL Server type.
fn column_type(ty: ColumnType) -> (&'static str, ColumnKind) {
    use ColumnKind::*;
    match ty {
        ColumnType::Null => ("NULL", Text),
        ColumnType::Bit | ColumnType::Bitn => ("BIT", Bool),
        ColumnType::Int1 => ("TINYINT", Number),
        ColumnType::Int2 => ("SMALLINT", Number),
        ColumnType::Int4 | ColumnType::Intn => ("INT", Number),
        ColumnType::Int8 => ("BIGINT", Number),
        ColumnType::Float4 => ("REAL", Number),
        ColumnType::Float8 | ColumnType::Floatn => ("FLOAT", Number),
        ColumnType::Money => ("MONEY", Number),
        ColumnType::Money4 => ("SMALLMONEY", Number),
        ColumnType::Decimaln => ("DECIMAL", Number),
        ColumnType::Numericn => ("NUMERIC", Number),
        ColumnType::Datetime4 => ("SMALLDATETIME", Temporal),
        ColumnType::Datetime | ColumnType::Datetimen => ("DATETIME", Temporal),
        ColumnType::Daten => ("DATE", Temporal),
        ColumnType::Timen => ("TIME", Temporal),
        ColumnType::Datetime2 => ("DATETIME2", Temporal),
        ColumnType::DatetimeOffsetn => ("DATETIMEOFFSET", Temporal),
        ColumnType::Guid => ("UNIQUEIDENTIFIER", Uuid),
        ColumnType::BigVarBin => ("VARBINARY", Binary),
        ColumnType::BigBinary => ("BINARY", Binary),
        ColumnType::Image => ("IMAGE", Binary),
        // geography, geometry, hierarchyid: their binary form
        ColumnType::Udt => ("UDT", Binary),
        ColumnType::BigVarChar => ("VARCHAR", Text),
        ColumnType::BigChar => ("CHAR", Text),
        ColumnType::NVarchar => ("NVARCHAR", Text),
        ColumnType::NChar => ("NCHAR", Text),
        ColumnType::Text => ("TEXT", Text),
        ColumnType::NText => ("NTEXT", Text),
        ColumnType::Xml => ("XML", Text),
        ColumnType::SSVariant => ("SQL_VARIANT", Text),
    }
}

/// A value as text, None for NULL: numbers and decimals exact, dates ISO-like as SQL Server
/// writes them, `\x…` hex for binary (as Postgres), bit as 1/0 (what a literal needs).
pub(crate) fn cell(value: &ColumnData<'_>) -> Option<String> {
    Some(match value {
        ColumnData::U8(v) => v.as_ref()?.to_string(),
        ColumnData::I16(v) => v.as_ref()?.to_string(),
        ColumnData::I32(v) => v.as_ref()?.to_string(),
        ColumnData::I64(v) => v.as_ref()?.to_string(),
        // money and smallmoney arrive as floats too
        ColumnData::F32(v) => v.as_ref()?.to_string(),
        ColumnData::F64(v) => v.as_ref()?.to_string(),
        ColumnData::Bit(v) => if (*v)? { "1" } else { "0" }.to_owned(),
        ColumnData::String(v) => v.as_deref()?.to_owned(),
        // SQL Server writes them upper case, as CAST(id AS varchar) does
        ColumnData::Guid(v) => v
            .as_ref()?
            .hyphenated()
            .encode_upper(&mut tiberius::Uuid::encode_buffer())
            .to_owned(),
        ColumnData::Binary(v) => hex_text(v.as_deref()?),
        ColumnData::Numeric(v) => decimal(v.as_ref()?.value(), v.as_ref()?.scale()),
        ColumnData::Xml(v) => v.as_deref()?.to_string(),
        ColumnData::DateTime(v) => {
            let v = v.as_ref()?;
            let (seconds, fraction) = (v.seconds_fragments() / 300, v.seconds_fragments() % 300);
            // 1/300 s ticks, shown as SQL Server rounds them: .000, .003, .007…
            let ms = (fraction * 10 + 1) / 3;
            let mut text = String::with_capacity(23);
            date(&mut text, i64::from(v.days()) + DAYS_1900);
            text.push(' ');
            clock(&mut text, u64::from(seconds));
            let _ = write!(text, ".{ms:03}");
            text
        }
        ColumnData::SmallDateTime(v) => {
            let v = v.as_ref()?;
            let mut text = String::with_capacity(19);
            date(&mut text, i64::from(v.days()) + DAYS_1900);
            text.push(' ');
            clock(&mut text, u64::from(v.seconds_fragments()) * 60);
            text
        }
        ColumnData::Date(v) => {
            let mut text = String::with_capacity(10);
            date(&mut text, i64::from(v.as_ref()?.days()));
            text
        }
        ColumnData::Time(v) => {
            let mut text = String::with_capacity(16);
            time(&mut text, v.as_ref()?);
            text
        }
        ColumnData::DateTime2(v) => datetime2(v.as_ref()?, 0),
        ColumnData::DateTimeOffset(v) => {
            let v = v.as_ref()?;
            // Stored as UTC plus the offset; shown in the offset's local time, as SQL Server does
            let minutes = i64::from(v.offset());
            let sign = if minutes < 0 { '-' } else { '+' };
            format!(
                "{} {sign}{:02}:{:02}",
                datetime2(&v.datetime2(), minutes),
                minutes.abs() / 60,
                minutes.abs() % 60
            )
        }
    })
}

/// Days from 0001-01-01 (SQL Server's `date`) to 1900-01-01 (`datetime`'s day 0).
const DAYS_1900: i64 = 693_595;

/// A decimal's digits with the point `scale` from the right; exact for every precision.
fn decimal(value: i128, scale: u8) -> String {
    let digits = value.unsigned_abs().to_string();
    let scale = usize::from(scale);
    let sign = if value < 0 { "-" } else { "" };
    if scale == 0 {
        return format!("{sign}{digits}");
    }
    let digits = format!("{digits:0>width$}", width = scale + 1);
    let (int, frac) = digits.split_at(digits.len() - scale);
    format!("{sign}{int}.{frac}")
}

/// Writes `days` after 0001-01-01 as YYYY-MM-DD (proleptic Gregorian, H. Hinnant's
/// civil_from_days).
fn date(out: &mut String, days: i64) {
    // Shift to days since 0000-03-01, so leap days end each 400-year era
    let z = days + 306;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let _ = write!(out, "{year:04}-{month:02}-{day:02}");
}

fn clock(out: &mut String, seconds: u64) {
    let _ = write!(
        out,
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    );
}

/// HH:MM:SS plus the column's own number of fraction digits (time(7): seven).
fn time(out: &mut String, t: &tiberius::time::Time) {
    let unit = 10u64.pow(u32::from(t.scale()));
    let (seconds, fraction) = (t.increments() / unit, t.increments() % unit);
    clock(out, seconds);
    if t.scale() > 0 {
        let _ = write!(out, ".{fraction:0width$}", width = usize::from(t.scale()));
    }
}

/// `datetime2` with `offset_minutes` added (datetimeoffset's local time).
fn datetime2(v: &tiberius::time::DateTime2, offset_minutes: i64) -> String {
    let t = v.time();
    let unit = 10i64.pow(u32::from(t.scale()));
    let increments = t.increments() as i64 + offset_minutes * 60 * unit;
    let per_day = 86_400 * unit;
    let days = i64::from(v.date().days()) + increments.div_euclid(per_day);
    let shifted = tiberius::time::Time::new(increments.rem_euclid(per_day) as u64, t.scale());
    let mut text = String::with_capacity(27);
    date(&mut text, days);
    text.push(' ');
    time(&mut text, &shifted);
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use tiberius::numeric::Numeric;
    use tiberius::time::{Date, DateTime, DateTime2, DateTimeOffset, SmallDateTime, Time};

    #[test]
    fn splits_scripts_at_go_lines() {
        assert_eq!(
            batches("CREATE VIEW v AS SELECT 1\ngo\n  GO  \nSELECT * FROM v\r\nGO\r\n"),
            ["CREATE VIEW v AS SELECT 1\n", "SELECT * FROM v\r\n"]
        );
        // GO inside a line, or as part of a name, is SQL
        assert_eq!(
            batches("SELECT 'go' AS go\nSELECT 1 AS gone"),
            ["SELECT 'go' AS go\nSELECT 1 AS gone"]
        );
        assert!(batches("  \nGO\n").is_empty());
    }

    #[test]
    fn quotes_names_in_brackets() {
        assert_eq!(quote("Order Details"), "[Order Details]");
        assert_eq!(quote("a]; DROP TABLE t; --"), "[a]]; DROP TABLE t; --]");
    }

    #[test]
    fn formats_values_like_sql_server() {
        let text = |v: ColumnData<'static>| cell(&v);
        assert_eq!(
            text(ColumnData::I64(Some(9_007_199_254_740_993))),
            Some("9007199254740993".into())
        );
        assert_eq!(text(ColumnData::I32(None)), None);
        assert_eq!(text(ColumnData::Bit(Some(true))), Some("1".into()));
        assert_eq!(text(ColumnData::F64(Some(12.5))), Some("12.5".into()));
        assert_eq!(
            text(ColumnData::Binary(Some(vec![0, 255].into()))),
            Some("\\x00ff".into())
        );
        let guid = tiberius::Uuid::parse_str("6f9619ff-8b86-d011-b42d-00c04fc964ff").unwrap();
        assert_eq!(
            text(ColumnData::Guid(Some(guid))),
            Some("6F9619FF-8B86-D011-B42D-00C04FC964FF".into())
        );
        // Decimals keep every digit and their scale
        let numeric = |v, s| text(ColumnData::Numeric(Some(Numeric::new_with_scale(v, s))));
        assert_eq!(numeric(12345, 2), Some("123.45".into()));
        assert_eq!(numeric(-5, 3), Some("-0.005".into()));
        assert_eq!(numeric(123, 0), Some("123".into()));
        assert_eq!(
            numeric(12_345_678_901_234_567_890_123_456_789, 10),
            Some("1234567890123456789.0123456789".into())
        );
    }

    #[test]
    fn formats_dates_and_times() {
        let text = |v: ColumnData<'static>| cell(&v).unwrap();
        // 2024-02-29 is 738_944 days after 0001-01-01
        assert_eq!(
            text(ColumnData::Date(Some(Date::new(738_944)))),
            "2024-02-29"
        );
        assert_eq!(text(ColumnData::Date(Some(Date::new(0)))), "0001-01-01");
        assert_eq!(
            text(ColumnData::Date(Some(Date::new(3_652_058)))),
            "9999-12-31"
        );
        // datetime: days since 1900, then 1/300 s ticks (10:30:00.997)
        let ticks = (10 * 3600 + 30 * 60) * 300 + 299;
        assert_eq!(
            text(ColumnData::DateTime(Some(DateTime::new(45_349, ticks)))),
            "2024-02-29 10:30:00.997"
        );
        assert_eq!(
            text(ColumnData::DateTime(Some(DateTime::new(-1, 1)))),
            "1899-12-31 00:00:00.003"
        );
        assert_eq!(
            text(ColumnData::SmallDateTime(Some(SmallDateTime::new(
                45_349, 61
            )))),
            "2024-02-29 01:01:00"
        );
        let t = Time::new((13 * 3600 + 5) * 10_000_000 + 1_234_567, 7);
        assert_eq!(text(ColumnData::Time(Some(t))), "13:00:05.1234567");
        assert_eq!(text(ColumnData::Time(Some(Time::new(59, 0)))), "00:00:59");
        let dt2 = DateTime2::new(Date::new(738_944), Time::new(23 * 3600 * 100 + 50, 2));
        assert_eq!(
            text(ColumnData::DateTime2(Some(dt2))),
            "2024-02-29 23:00:00.50"
        );
        // 23:00 UTC at +05:30 is 04:30 the next day
        let dto = DateTimeOffset::new(dt2, 330);
        assert_eq!(
            text(ColumnData::DateTimeOffset(Some(dto))),
            "2024-03-01 04:30:00.50 +05:30"
        );
        let dto = DateTimeOffset::new(DateTime2::new(Date::new(738_944), Time::new(0, 0)), -480);
        assert_eq!(
            text(ColumnData::DateTimeOffset(Some(dto))),
            "2024-02-28 16:00:00 -08:00"
        );
    }

    #[test]
    fn maps_column_types_to_kinds() {
        use ColumnKind::*;
        let kinds = [
            ColumnType::Bitn,
            ColumnType::Intn,
            ColumnType::Decimaln,
            ColumnType::Datetime2,
            ColumnType::Guid,
            ColumnType::BigVarBin,
            ColumnType::NVarchar,
        ]
        .map(|t| column_type(t).1);
        assert_eq!(kinds, [Bool, Number, Number, Temporal, Uuid, Binary, Text]);
    }

    /// Needs a SQL Server, so it only runs when asked:
    /// `QUERYCRAFT_MSSQL_URL='server=tcp:localhost,1433;user=sa;password=…;TrustServerCertificate=true' cargo test -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn runs_batches_against_sql_server() {
        let url = std::env::var("QUERYCRAFT_MSSQL_URL").expect("QUERYCRAFT_MSSQL_URL");
        let config = Config::from_ado_string(&url).unwrap();
        let mut client = connect(config).await.unwrap();
        let out = run_batches(
            &mut client,
            "CREATE TABLE #t (id int PRIMARY KEY, d decimal(10,2), at datetime2(3), u uniqueidentifier, b varbinary(4));
             INSERT INTO #t VALUES (1, 12.50, '2024-02-29 10:30:00.123', '6F9619FF-8B86-D011-B42D-00C04FC964FF', 0x00ff), (2, NULL, NULL, NULL, NULL);
             GO
             SELECT * FROM #t ORDER BY id",
            MAX_KEEP,
        )
        .await
        .unwrap();
        assert_eq!(out.rows_affected, 2);
        assert_eq!(
            out.rows[0],
            [
                Some("1".into()),
                Some("12.50".into()),
                Some("2024-02-29 10:30:00.123".into()),
                Some("6F9619FF-8B86-D011-B42D-00C04FC964FF".into()),
                Some("\\x00ff".into())
            ]
        );
        let kinds: Vec<_> = out.columns.iter().map(|c| c.kind).collect();
        use ColumnKind::*;
        assert_eq!(kinds, [Number, Number, Temporal, Uuid, Binary]);

        // No result set: the last statement's row count
        let out = run_batches(&mut client, "UPDATE #t SET d = 1", MAX_KEEP)
            .await
            .unwrap();
        assert!(out.columns.is_empty());
        assert_eq!(out.rows_affected, 2);
        assert_eq!(
            execute_counted(&mut client, "UPDATE #t SET d = 2 WHERE id = 1")
                .await
                .unwrap(),
            1
        );
        assert!(run_batches(&mut client, "SELEC 1", MAX_KEEP).await.is_err());
    }

    const MAX_KEEP: usize = crate::query::MAX_ROWS;
}
