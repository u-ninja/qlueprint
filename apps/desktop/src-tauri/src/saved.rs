//! Saved connections: settings in `<app data>/connections.json`, Postgres and MySQL passwords in the OS
//! credential store (Windows Credential Manager, macOS Keychain, Secret Service). Neither the
//! file nor the UI ever holds a password.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use keyring::Entry;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::db::{self, CommandError, ConnectRequest, Connections, ErrorCode, Server, ServerLogin};

const KEYRING_SERVICE: &str = "QueryCraft";
const FILE: &str = "connections.json";

/// A `ConnectRequest` minus the password.
#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SavedConfig {
    Postgres(Server),
    Mysql(Server),
    Sqlite { path: String },
}

#[derive(Clone, Serialize, Deserialize, Type)]
pub struct SavedConnection {
    id: String,
    label: String,
    config: SavedConfig,
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

    /// Writes the new list to disk, then makes it current. Write-then-rename, so a crash
    /// mid-write leaves the previous file intact.
    fn replace(&self, list: Vec<SavedConnection>) -> Result<(), CommandError> {
        let fail = |e: std::io::Error| save_failed("the connection", e);
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir).map_err(fail)?;
        }
        let json = serde_json::to_string_pretty(&list).expect("saved connections serialize");
        let tmp = self.file.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(fail)?;
        fs::rename(&tmp, &self.file).map_err(fail)?;
        *self.list.lock().expect("saved lock poisoned") = list;
        Ok(())
    }
}

fn new_id() -> String {
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

/// Connects, and saves the connection only once that worked.
#[tauri::command]
#[specta::specta]
pub async fn connect_and_save(
    request: ConnectRequest,
    label: String,
    saved: State<'_, Saved>,
    connections: State<'_, Connections>,
) -> Result<SavedConnection, CommandError> {
    let (config, password) = match &request {
        ConnectRequest::Postgres(login) => (
            SavedConfig::Postgres(login.server.clone()),
            login.password.clone(),
        ),
        ConnectRequest::Mysql(login) => (
            SavedConfig::Mysql(login.server.clone()),
            login.password.clone(),
        ),
        ConnectRequest::Sqlite { path } => {
            (SavedConfig::Sqlite { path: path.clone() }, String::new())
        }
    };
    let pool = db::open(request).await?;

    let entry = SavedConnection {
        id: new_id(),
        label,
        config,
    };
    let stored = (|| {
        if !password.is_empty() {
            credential(&entry.id)?
                .set_password(&password)
                .map_err(credential_failed)?;
        }
        let mut list = saved.snapshot();
        list.push(entry.clone());
        saved.replace(list)
    })();
    if let Err(error) = stored {
        // Not saved, so don't leave it open either: the UI shows the error instead
        pool.close().await;
        return Err(error);
    }

    register(&connections, entry.id.clone(), pool).await;
    Ok(entry)
}

/// Opens a saved connection; a no-op if it's already open (e.g. after a UI reload).
#[tauri::command]
#[specta::specta]
pub async fn connect_saved(
    id: String,
    saved: State<'_, Saved>,
    connections: State<'_, Connections>,
) -> Result<(), CommandError> {
    if connections.is_open(&id) {
        return Ok(());
    }
    let config = saved
        .snapshot()
        .into_iter()
        .find(|s| s.id == id)
        .map(|s| s.config)
        .ok_or(CommandError::new(
            ErrorCode::InvalidInput,
            "This saved connection no longer exists.",
        ))?;

    let login = |server| -> Result<ServerLogin, CommandError> {
        // No entry means it was saved without a password
        let password = match credential(&id)?.get_password() {
            Ok(password) => password,
            Err(keyring::Error::NoEntry) => String::new(),
            Err(e) => return Err(credential_failed(e)),
        };
        Ok(ServerLogin { server, password })
    };
    let request = match config {
        SavedConfig::Postgres(server) => ConnectRequest::Postgres(login(server)?),
        SavedConfig::Mysql(server) => ConnectRequest::Mysql(login(server)?),
        SavedConfig::Sqlite { path } => ConnectRequest::Sqlite { path },
    };
    let pool = db::open(request).await?;
    register(&connections, id, pool).await;
    Ok(())
}

/// Forgets a saved connection and its password, closing it if open.
#[tauri::command]
#[specta::specta]
pub async fn forget_saved(
    id: String,
    saved: State<'_, Saved>,
    connections: State<'_, Connections>,
) -> Result<(), CommandError> {
    let list = saved
        .snapshot()
        .into_iter()
        .filter(|s| s.id != id)
        .collect();
    saved.replace(list)?;
    match credential(&id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(credential_failed(e)),
    }
    if let Some(pool) = connections.remove(&id) {
        pool.close().await;
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
