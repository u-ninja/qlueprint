//! Saved connections: settings in `<app data>/connections.json`, Postgres, MySQL and SQL Server
//! passwords (or a Microsoft sign-in's refresh token) in the OS credential store (Windows
//! Credential Manager, macOS Keychain, Secret Service). Neither the file nor the UI ever holds one.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use keyring::Entry;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::audit::{Audit, Details, Engine, EventKind};
use crate::db::{self, CommandError, ConnectRequest, Connections, ErrorCode, Server, ServerLogin};
use crate::mssql::{MssqlLogin, MssqlServer};

const KEYRING_SERVICE: &str = "QueryCraft";
const FILE: &str = "connections.json";

/// A `ConnectRequest` minus the password.
#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SavedConfig {
    Postgres(Server),
    Mysql(Server),
    Mssql(MssqlServer),
    Sqlite { path: String },
}

#[derive(Clone, Serialize, Deserialize, Type)]
pub struct SavedConnection {
    id: String,
    label: String,
    config: SavedConfig,
}

impl SavedConnection {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn label(&self) -> &str {
        &self.label
    }

    /// What audit entries say about this connection: never the password.
    fn audit_details(&self) -> Details {
        Details {
            label: Some(self.label.clone()),
            ..config_details(&self.config)
        }
    }
}

/// What audit entries say about a connection's settings: never the password.
fn config_details(config: &SavedConfig) -> Details {
    let server = |engine, s: &Server| Details {
        engine: Some(engine),
        target: Some(format!("{}@{}:{}", s.user, s.host, s.port)),
        database: (!s.database.is_empty()).then(|| s.database.clone()),
        ..Default::default()
    };
    match config {
        SavedConfig::Postgres(s) => server(Engine::Postgres, s),
        SavedConfig::Mysql(s) => server(Engine::Mysql, s),
        SavedConfig::Mssql(s) => {
            let user = Some(s.user.trim())
                .filter(|u| !u.is_empty())
                .map_or_else(String::new, |u| format!("{u}@"));
            Details {
                engine: Some(Engine::Mssql),
                target: Some(format!("{user}{}:{}", s.address(), s.port)),
                database: (!s.database.is_empty()).then(|| s.database.clone()),
                ..Default::default()
            }
        }
        SavedConfig::Sqlite { path } => Details {
            engine: Some(Engine::Sqlite),
            target: Some(path.clone()),
            ..Default::default()
        },
    }
}

/// A connection name as saved: trimmed, and never blank.
fn clean_label(label: &str) -> Result<String, CommandError> {
    let label = label.trim();
    if label.is_empty() {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            "Give the connection a name.",
        ));
    }
    Ok(label.to_owned())
}

pub struct Saved {
    file: PathBuf,
    // Held only to read or swap the list, never across an await.
    list: Mutex<Vec<SavedConnection>>,
}

fn save_failed(what: &str, error: impl std::fmt::Display) -> CommandError {
    CommandError::new(
        ErrorCode::SaveFailed,
        format!("Couldn't save {what}: {error}"),
    )
}

fn credential_failed(error: impl std::fmt::Display) -> CommandError {
    CommandError::new(
        ErrorCode::CredentialFailed,
        format!("Couldn't use the system credential store: {error}"),
    )
}

/// The credential store entry for one saved connection's password.
fn credential(id: &str) -> Result<Entry, CommandError> {
    Entry::new(KEYRING_SERVICE, id).map_err(credential_failed)
}

/// A connection's secret once read from or written to the credential store (`None`: there's no
/// entry). Concurrent first reads wait for one Keychain read.
type SecretCell = Arc<tokio::sync::OnceCell<Option<String>>>;

// Secrets this run, by connection id. Each read of the macOS Keychain can prompt for the login
// password (always, for an unsigned dev build), so a connection's secret is read at most once.
static SECRETS: LazyLock<Mutex<HashMap<String, SecretCell>>> = LazyLock::new(Default::default);

fn secrets() -> std::sync::MutexGuard<'static, HashMap<String, SecretCell>> {
    SECRETS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Runs a credential store call on Tokio's blocking pool: it can wait on a Keychain prompt.
async fn keychain<T: Send + 'static>(
    id: &str,
    call: impl FnOnce(Entry) -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    let entry = credential(id)?;
    tokio::task::spawn_blocking(move || call(entry))
        .await
        .map_err(credential_failed)?
}

/// The connection's stored secret (password or refresh token), `None` when it has none
async fn read_secret(id: &str) -> Result<Option<String>, CommandError> {
    let cell = secrets().entry(id.to_owned()).or_default().clone();
    cell.get_or_try_init(|| {
        keychain(id, |entry| match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(credential_failed(e)),
        })
    })
    .await
    .cloned()
}

async fn store_secret(id: &str, secret: &str) -> Result<(), CommandError> {
    let owned = secret.to_owned();
    keychain(id, move |entry| {
        entry.set_password(&owned).map_err(credential_failed)
    })
    .await?;
    let cell = tokio::sync::OnceCell::new_with(Some(Some(secret.to_owned())));
    secrets().insert(id.to_owned(), Arc::new(cell));
    Ok(())
}

/// Opens `request`'s pool; a failure is audited as ConnectionFailed under `id` (None: nothing
/// was saved).
async fn open_audited(
    request: impl Future<Output = Result<ConnectRequest, CommandError>>,
    id: Option<&str>,
    details: &Details,
    audit: &Audit,
) -> Result<db::Open, CommandError> {
    let opened = async { db::open(request.await?).await }.await;
    if let Err(error) = &opened {
        let details = details.clone().with_error(error);
        audit.record(EventKind::ConnectionFailed, id, details).await;
    }
    opened
}

impl Saved {
    pub fn load(dir: PathBuf) -> Self {
        let file = dir.join(FILE);
        let list = match fs::read_to_string(&file) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| {
                // Keep the unreadable file for the user instead of overwriting it on the next save
                let _ = fs::rename(&file, file.with_extension("json.unreadable"));
                Vec::new()
            }),
            Err(_) => Vec::new(),
        };
        Self {
            file,
            list: Mutex::new(list),
        }
    }

    fn snapshot(&self) -> Vec<SavedConnection> {
        self.list.lock().expect("saved lock poisoned").clone()
    }

    fn find(&self, id: &str) -> Option<SavedConnection> {
        let list = self.list.lock().expect("saved lock poisoned");
        list.iter().find(|s| s.id == id).cloned()
    }

    /// The audit details of a saved connection, `None` if it no longer exists.
    pub(crate) fn audit_details(&self, id: &str) -> Option<Details> {
        self.find(id).map(|s| s.audit_details())
    }

    /// Writes the new list to disk, then makes it current. Write-then-rename, so a crash
    /// mid-write leaves the previous file intact.
    fn replace(&self, list: Vec<SavedConnection>) -> Result<(), CommandError> {
        write_json(&self.file, &list).map_err(|e| save_failed("the connection", e))?;
        *self.list.lock().expect("saved lock poisoned") = list;
        Ok(())
    }

    /// The request that opens a saved connection, with its password from the credential store.
    pub(crate) async fn request(&self, id: &str) -> Result<ConnectRequest, CommandError> {
        let entry = self.find(id).ok_or_else(missing)?;
        connect_request(id, entry.config).await
    }

    /// Changes one saved connection in place (same id, same position) and writes the list.
    fn edit(
        &self,
        id: &str,
        change: impl FnOnce(&mut SavedConnection),
    ) -> Result<SavedConnection, CommandError> {
        let mut list = self.snapshot();
        let entry = list.iter_mut().find(|s| s.id == id).ok_or_else(missing)?;
        change(entry);
        let entry = entry.clone();
        self.replace(list)?;
        Ok(entry)
    }

    /// Renames a saved connection; the name is trimmed and can't be blank.
    fn rename(&self, id: &str, label: &str) -> Result<SavedConnection, CommandError> {
        let label = clean_label(label)?;
        self.edit(id, |s| s.label = label)
    }
}

fn missing() -> CommandError {
    CommandError::new(
        ErrorCode::InvalidInput,
        "This saved connection no longer exists.",
    )
}

/// What gets saved from a request: its settings, and its password (empty for none or SQLite).
fn split(request: &ConnectRequest) -> (SavedConfig, String) {
    match request {
        ConnectRequest::Postgres(login) => (
            SavedConfig::Postgres(login.server.clone()),
            login.password.clone(),
        ),
        ConnectRequest::Mysql(login) => (
            SavedConfig::Mysql(login.server.clone()),
            login.password.clone(),
        ),
        ConnectRequest::Mssql(login) => (
            SavedConfig::Mssql(login.server.clone()),
            login.password.clone(),
        ),
        ConnectRequest::Sqlite { path } => {
            (SavedConfig::Sqlite { path: path.clone() }, String::new())
        }
    }
}

/// What the credential store keeps for a connection that just opened: its password, or for a
/// Microsoft interactive sign-in the newest refresh token (the connect may have signed in again
/// or been given a new one).
fn secret(config: &SavedConfig, password: String) -> String {
    match config {
        SavedConfig::Mssql(server) => crate::entra::refresh_token(server).unwrap_or(password),
        _ => password,
    }
}

/// Writes `value` as pretty JSON to `file`, creating its directory. Write-then-rename, so a
/// crash mid-write leaves the previous file intact.
pub(crate) fn write_json(file: &Path, value: &impl Serialize) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(value).expect("JSON serializes");
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(&tmp, file)
}

pub(crate) fn new_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos:x}")
}

/// Registers a pool for a saved connection, closing it if one was already open.
async fn register(connections: &Connections, id: String, open: db::Open) {
    if let Some(duplicate) = connections.insert(id, open) {
        duplicate.close().await;
    }
}

#[tauri::command]
#[specta::specta]
pub fn list_saved(saved: State<'_, Saved>) -> Vec<SavedConnection> {
    saved.snapshot()
}

/// Connects, and saves the connection under `label` (trimmed, not blank) only once that worked.
#[tauri::command]
#[specta::specta]
pub async fn connect_and_save(
    request: ConnectRequest,
    label: String,
    saved: State<'_, Saved>,
    connections: State<'_, Connections>,
    audit: State<'_, Audit>,
) -> Result<SavedConnection, CommandError> {
    save_connection(request, label, &saved, &connections, &audit).await
}

/// `connect_and_save` without Tauri's State, so tests and local provisioning can call it.
pub(crate) async fn save_connection(
    request: ConnectRequest,
    label: String,
    saved: &Saved,
    connections: &Connections,
    audit: &Audit,
) -> Result<SavedConnection, CommandError> {
    let label = clean_label(&label)?;
    let (config, password) = split(&request);
    let entry = SavedConnection {
        id: new_id(),
        label,
        config,
    };
    let details = entry.audit_details();
    // No connection id: nothing was saved
    let pool = open_audited(async { Ok(request) }, None, &details, audit).await?;
    let password = secret(&entry.config, password);

    let mut password_stored = false;
    let stored = async {
        if !password.is_empty() {
            store_secret(&entry.id, &password).await?;
            password_stored = true;
        }
        let mut list = saved.snapshot();
        list.push(entry.clone());
        saved.replace(list)
    }
    .await;
    let id = Some(entry.id.as_str());
    if password_stored {
        audit
            .record(EventKind::CredentialStored, id, details.clone())
            .await;
    }
    if let Err(error) = stored {
        // Not saved, so don't leave it open either: the UI shows the error instead
        pool.close().await;
        return Err(error);
    }

    register(connections, entry.id.clone(), pool).await;
    audit
        .record(EventKind::ConnectionSaved, id, details.clone())
        .await;
    audit.record(EventKind::ConnectionOpened, id, details).await;
    Ok(entry)
}

/// Opens a saved connection; a no-op if it's already open (e.g. after a UI reload).
#[tauri::command]
#[specta::specta]
pub async fn connect_saved(
    id: String,
    saved: State<'_, Saved>,
    connections: State<'_, Connections>,
    audit: State<'_, Audit>,
) -> Result<(), CommandError> {
    if connections.is_open(&id) {
        return Ok(());
    }
    let Some(entry) = saved.find(&id) else {
        return Err(missing());
    };
    let details = entry.audit_details();
    let request = connect_request(&id, entry.config.clone());
    let pool = open_audited(request, Some(&id), &details, &audit).await?;
    // A refresh or a new sign-in replaced the stored refresh token
    if let SavedConfig::Mssql(server) = &entry.config
        && let Some(refresh) = crate::entra::refresh_token(server)
        && read_secret(&id).await.ok().flatten().as_ref() != Some(&refresh)
    {
        store_secret(&id, &refresh).await?;
        audit
            .record(EventKind::CredentialStored, Some(&id), details.clone())
            .await;
    }
    register(&connections, id.clone(), pool).await;
    audit
        .record(EventKind::ConnectionOpened, Some(&id), details)
        .await;
    Ok(())
}

/// Renames a saved connection. Returns it as saved.
#[tauri::command]
#[specta::specta]
pub async fn rename_saved(
    id: String,
    label: String,
    saved: State<'_, Saved>,
    audit: State<'_, Audit>,
) -> Result<SavedConnection, CommandError> {
    let entry = saved.rename(&id, &label)?;
    audit
        .record(EventKind::ConnectionSaved, Some(&id), entry.audit_details())
        .await;
    Ok(entry)
}

/// Changes a saved connection's settings and name, keeping its id. An empty password keeps the
/// saved one. Like `connect_and_save`, nothing changes unless the new settings connect; the
/// connection is then (re)opened with them.
#[tauri::command]
#[specta::specta]
pub async fn update_saved(
    id: String,
    request: ConnectRequest,
    label: String,
    saved: State<'_, Saved>,
    connections: State<'_, Connections>,
    audit: State<'_, Audit>,
) -> Result<SavedConnection, CommandError> {
    update(&id, request, &label, &saved, &connections, &audit).await
}

/// `update_saved` without Tauri's State, for tests.
pub(crate) async fn update(
    id: &str,
    request: ConnectRequest,
    label: &str,
    saved: &Saved,
    connections: &Connections,
    audit: &Audit,
) -> Result<SavedConnection, CommandError> {
    let label = clean_label(label)?;
    saved.find(id).ok_or_else(missing)?;
    let (config, password) = split(&request);
    let request = if password.is_empty() {
        connect_request(id, config.clone()).await?
    } else {
        request
    };
    let entry = SavedConnection {
        id: id.to_owned(),
        label,
        config,
    };
    let details = entry.audit_details();
    let pool = open_audited(async { Ok(request) }, Some(id), &details, audit).await?;
    let password = secret(&entry.config, password);

    let mut password_stored = false;
    let stored = async {
        if !password.is_empty() {
            store_secret(id, &password).await?;
            password_stored = true;
        }
        let (config, label) = (entry.config.clone(), entry.label.clone());
        saved.edit(id, |s| {
            s.config = config;
            s.label = label;
        })
    }
    .await;
    if password_stored {
        audit
            .record(EventKind::CredentialStored, Some(id), details.clone())
            .await;
    }
    if let Err(error) = stored {
        pool.close().await;
        return Err(error);
    }
    audit
        .record(EventKind::ConnectionSaved, Some(id), details.clone())
        .await;

    // Swap the pool: the old one (and its other-database pools) used the old settings
    if let Some(old) = connections.remove(id) {
        old.close().await;
        audit
            .record(EventKind::ConnectionClosed, Some(id), details.clone())
            .await;
    }
    register(connections, id.to_owned(), pool).await;
    audit
        .record(EventKind::ConnectionOpened, Some(id), details)
        .await;
    Ok(entry)
}

/// Tries settings without saving them or storing the password. With `saved_id` and an empty
/// password, the saved connection's password is used, as `update_saved` would.
#[tauri::command]
#[specta::specta]
pub async fn test_connection(
    request: ConnectRequest,
    saved_id: Option<String>,
    audit: State<'_, Audit>,
) -> Result<(), CommandError> {
    test(request, saved_id.as_deref(), &audit).await
}

/// `test_connection` without Tauri's State, for tests.
pub(crate) async fn test(
    request: ConnectRequest,
    saved_id: Option<&str>,
    audit: &Audit,
) -> Result<(), CommandError> {
    let (config, password) = split(&request);
    let details = config_details(&config);
    let request = match saved_id {
        Some(id) if password.is_empty() => connect_request(id, config).await?,
        _ => request,
    };
    // No connection id: nothing is saved, and the pool closes right away
    let pool = open_audited(async { Ok(request) }, None, &details, audit).await?;
    pool.close().await;
    audit
        .record(EventKind::ConnectionOpened, None, details.clone())
        .await;
    audit
        .record(EventKind::ConnectionClosed, None, details)
        .await;
    Ok(())
}

/// A saved connection's request, with the password (if any) from the credential store.
async fn connect_request(id: &str, config: SavedConfig) -> Result<ConnectRequest, CommandError> {
    let password = match config {
        SavedConfig::Sqlite { .. } => String::new(),
        // No entry means it was saved without a password
        _ => read_secret(id).await?.unwrap_or_default(),
    };
    let request = match config {
        SavedConfig::Postgres(server) => ConnectRequest::Postgres(ServerLogin { server, password }),
        SavedConfig::Mysql(server) => ConnectRequest::Mysql(ServerLogin { server, password }),
        SavedConfig::Mssql(server) => ConnectRequest::Mssql(MssqlLogin { server, password }),
        SavedConfig::Sqlite { path } => ConnectRequest::Sqlite { path },
    };
    Ok(request)
}

/// Forgets a saved connection and its password, closing it if open.
#[tauri::command]
#[specta::specta]
pub async fn forget_saved(
    id: String,
    saved: State<'_, Saved>,
    connections: State<'_, Connections>,
    audit: State<'_, Audit>,
) -> Result<(), CommandError> {
    forget(&id, &saved, &connections, &audit).await
}

/// `forget_saved` without Tauri's State, for local databases whose data was deleted.
pub(crate) async fn forget(
    id: &str,
    saved: &Saved,
    connections: &Connections,
    audit: &Audit,
) -> Result<(), CommandError> {
    let details = saved.audit_details(id).unwrap_or_default();
    let list = saved
        .snapshot()
        .into_iter()
        .filter(|s| s.id != id)
        .collect();
    saved.replace(list)?;
    let forgotten = Some(id);
    audit
        .record(EventKind::ConnectionForgotten, forgotten, details.clone())
        .await;
    secrets().remove(id);
    let deleted = keychain(id, |entry| match entry.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(credential_failed(e)),
    })
    .await?;
    if deleted {
        audit
            .record(EventKind::CredentialDeleted, forgotten, details.clone())
            .await;
    }
    if let Some(pool) = connections.remove(id) {
        pool.close().await;
        audit
            .record(EventKind::ConnectionClosed, forgotten, details)
            .await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_reloads_without_passwords() {
        let dir = std::env::temp_dir().join(format!("qc-saved-{}", new_id()));
        let saved = Saved::load(dir.clone());
        let entry = SavedConnection {
            id: "a".into(),
            label: "shop@localhost".into(),
            config: SavedConfig::Postgres(Server {
                host: "localhost".into(),
                port: 5432,
                user: "postgres".into(),
                database: "shop".into(),
                show_all_databases: true,
                ..Default::default()
            }),
        };
        saved.replace(vec![entry]).unwrap();

        let text = fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(!text.contains("password"));
        assert!(text.contains(r#""showAllDatabases": true"#));
        let reloaded = Saved::load(dir.clone()).snapshot();
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].label, "shop@localhost");
        let _ = fs::remove_dir_all(dir);
    }

    /// Touches the real OS credential store, so it only runs when asked: `cargo test -- --ignored`
    #[test]
    #[ignore]
    fn round_trips_a_password_through_the_os_store() {
        let entry = Entry::new("QueryCraft-test", &new_id()).unwrap();
        entry.set_password("s3cret").unwrap();
        assert_eq!(entry.get_password().unwrap(), "s3cret");
        entry.delete_credential().unwrap();
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }

    /// Files written before MySQL support keep loading: the JSON shape didn't change.
    #[test]
    fn reads_flat_server_configs() {
        let json = r#"[
            {"id":"a","label":"pg","config":{"kind":"postgres","host":"h","port":5432,"user":"u","database":""}},
            {"id":"b","label":"my","config":{"kind":"mysql","host":"h","port":3306,"user":"root","database":"shop"}}
        ]"#;
        let list: Vec<SavedConnection> = serde_json::from_str(json).unwrap();
        assert!(matches!(&list[0].config, SavedConfig::Postgres(s) if s.port == 5432));
        assert!(matches!(&list[1].config, SavedConfig::Mysql(s) if s.database == "shop"));
        // Saved before the SSL option: today's behaviour, prefer
        assert!(
            matches!(&list[0].config, SavedConfig::Postgres(s) if s.ssl_mode == db::SslMode::Prefer)
        );
    }

    /// The SSL mode and SQL Server's settings round-trip; the default mode isn't written.
    #[test]
    fn saves_ssl_modes_and_sql_server_settings() {
        let json = r#"[
            {"id":"a","label":"pg","config":{"kind":"postgres","host":"h","port":5432,"user":"u","database":"","sslMode":"verify-full","sslCa":"/ca.pem"}},
            {"id":"b","label":"az","config":{"kind":"mssql","host":"x.database.windows.net","port":1433,"user":"ada@contoso.com","database":"shop",
              "auth":"entra_interactive","encrypt":true,"trustServerCertificate":false}}
        ]"#;
        let list: Vec<SavedConnection> = serde_json::from_str(json).unwrap();
        assert!(
            matches!(&list[0].config, SavedConfig::Postgres(s) if s.ssl_mode == db::SslMode::VerifyFull && s.ssl_ca == "/ca.pem")
        );
        let SavedConfig::Mssql(server) = &list[1].config else {
            panic!("not SQL Server")
        };
        assert_eq!(server.auth, crate::mssql::MssqlAuth::EntraInteractive);
        assert!(server.instance.is_empty() && server.tenant_id.is_empty());
        assert_eq!(
            config_details(&list[1].config).target.as_deref(),
            Some("ada@contoso.com@x.database.windows.net:1433")
        );
        let text = serde_json::to_string(&list).unwrap();
        assert!(text.contains(r#""sslMode":"verify-full""#));
        let plain = SavedConfig::Mysql(Server::default());
        assert!(!serde_json::to_string(&plain).unwrap().contains("sslMode"));
    }

    /// The password goes to the OS store only; the audit file never sees it, even when the
    /// connect fails and the entry records the error.
    #[tokio::test]
    async fn connect_and_save_never_writes_the_password_to_the_audit_log() {
        use crate::audit::tests::{file_text, temp_dir};
        let dir = temp_dir();
        let saved = Saved::load(dir.clone());
        let connections = Connections::default();
        let audit = Audit::open(&dir).await;
        let password = "hunter2-do-not-log";
        // Nothing listens on port 1, so the connect fails before the credential store is used
        let request = ConnectRequest::Postgres(ServerLogin {
            server: Server {
                host: "127.0.0.1".into(),
                port: 1,
                user: "app".into(),
                database: "shop".into(),
                show_all_databases: false,
                ..Default::default()
            },
            password: password.into(),
        });
        let result = save_connection(request, "shop".into(), &saved, &connections, &audit).await;
        assert!(result.is_err());

        // A SQLite connection saves and opens for real
        let file = dir.join("shop.db");
        fs::write(&file, b"").unwrap();
        let path = file.to_string_lossy().into_owned();
        let request = ConnectRequest::Sqlite { path };
        save_connection(request, "shop.db".into(), &saved, &connections, &audit)
            .await
            .unwrap();
        let report = audit.verify().await.unwrap();
        assert!(report.intact && report.entries == 3);

        let text = file_text(audit, &dir).await;
        assert!(text.contains("connection_failed") && text.contains("app@127.0.0.1:1"));
        assert!(text.contains("connection_saved") && text.contains("connection_opened"));
        assert!(!text.contains(password));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn renames_in_place_trimmed_and_never_blank() {
        let dir = std::env::temp_dir().join(format!("qc-saved-{}", new_id()));
        let saved = Saved::load(dir.clone());
        let entry = |id: &str| SavedConnection {
            id: id.into(),
            label: id.into(),
            config: SavedConfig::Sqlite {
                path: "x.db".into(),
            },
        };
        saved.replace(vec![entry("a"), entry("b")]).unwrap();

        assert_eq!(saved.rename("a", "  Shop  ").unwrap().label, "Shop");
        assert!(saved.rename("a", "   ").is_err());
        assert!(saved.rename("missing", "x").is_err());
        let reloaded = Saved::load(dir.clone()).snapshot();
        let labels: Vec<_> = reloaded.iter().map(|s| s.label.as_str()).collect();
        assert_eq!(labels, ["Shop", "b"]);
        let _ = fs::remove_dir_all(dir);
    }

    /// Editing keeps the id and name, changes only once the new settings connect, and swaps
    /// the open pool.
    #[tokio::test]
    async fn update_keeps_the_entry_and_swaps_the_pool() {
        use crate::audit::tests::{file_text, temp_dir};
        let dir = temp_dir();
        let saved = Saved::load(dir.clone());
        let connections = Connections::default();
        let audit = Audit::open(&dir).await;
        let db = |name: &str| {
            let file = dir.join(name);
            fs::write(&file, b"").unwrap();
            ConnectRequest::Sqlite {
                path: file.to_string_lossy().into_owned(),
            }
        };
        let first = save_connection(db("a.db"), "Mine".into(), &saved, &connections, &audit)
            .await
            .unwrap();

        // A file in a missing folder can't open: nothing changes
        let bad = ConnectRequest::Sqlite {
            path: dir.join("nope/x.db").to_string_lossy().into_owned(),
        };
        assert!(
            update(&first.id, bad, "Mine", &saved, &connections, &audit)
                .await
                .is_err()
        );
        assert!(
            matches!(&saved.find(&first.id).unwrap().config, SavedConfig::Sqlite { path } if path.ends_with("a.db"))
        );

        assert!(
            update(&first.id, db("b.db"), "  ", &saved, &connections, &audit)
                .await
                .is_err()
        );
        let updated = update(
            &first.id,
            db("b.db"),
            " Ours ",
            &saved,
            &connections,
            &audit,
        )
        .await
        .unwrap();
        assert_eq!(
            (updated.id.as_str(), updated.label.as_str()),
            (first.id.as_str(), "Ours")
        );
        assert!(
            matches!(&saved.find(&first.id).unwrap().config, SavedConfig::Sqlite { path } if path.ends_with("b.db"))
        );
        assert_eq!(saved.snapshot().len(), 1);
        assert!(connections.is_open(&first.id));

        let text = file_text(audit, &dir).await;
        assert!(text.contains("connection_closed"));
        let _ = fs::remove_dir_all(dir);
    }

    /// The name given at creation is saved trimmed; a blank one is refused before connecting.
    #[tokio::test]
    async fn saves_under_the_given_name() {
        use crate::audit::tests::temp_dir;
        let dir = temp_dir();
        let saved = Saved::load(dir.clone());
        let connections = Connections::default();
        let audit = Audit::open(&dir).await;
        let file = dir.join("shop.db");
        fs::write(&file, b"").unwrap();
        let request = || ConnectRequest::Sqlite {
            path: file.to_string_lossy().into_owned(),
        };
        let blank = save_connection(request(), " \t".into(), &saved, &connections, &audit).await;
        assert!(blank.is_err() && saved.snapshot().is_empty());
        let entry = save_connection(
            request(),
            "  Shop (dev) ".into(),
            &saved,
            &connections,
            &audit,
        )
        .await
        .unwrap();
        assert_eq!(entry.label, "Shop (dev)");
        assert_eq!(Saved::load(dir.clone()).snapshot()[0].label, "Shop (dev)");
        let _ = fs::remove_dir_all(dir);
    }

    /// Testing saves nothing, opens nothing, and keeps the password out of the audit log.
    #[tokio::test]
    async fn test_connection_saves_nothing() {
        use crate::audit::tests::{file_text, temp_dir};
        let dir = temp_dir();
        let audit = Audit::open(&dir).await;
        let password = "hunter2-do-not-log";
        let request = ConnectRequest::Postgres(ServerLogin {
            server: Server {
                host: "127.0.0.1".into(),
                port: 1,
                user: "app".into(),
                database: "shop".into(),
                show_all_databases: false,
                ..Default::default()
            },
            password: password.into(),
        });
        assert!(test(request, None, &audit).await.is_err());
        let file = dir.join("shop.db");
        fs::write(&file, b"").unwrap();
        let path = file.to_string_lossy().into_owned();
        test(ConnectRequest::Sqlite { path }, None, &audit)
            .await
            .unwrap();
        assert!(!dir.join(FILE).exists());

        let text = file_text(audit, &dir).await;
        assert!(text.contains("connection_failed") && text.contains("connection_closed"));
        assert!(!text.contains(password));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn sets_an_unreadable_file_aside() {
        let dir = std::env::temp_dir().join(format!("qc-saved-{}", new_id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(FILE), "not json").unwrap();
        assert!(Saved::load(dir.clone()).snapshot().is_empty());
        assert!(dir.join("connections.json.unreadable").exists());
        let _ = fs::remove_dir_all(dir);
    }
}
