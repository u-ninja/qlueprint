//! What crosses to the UI for local databases: the engine catalog, requests, plans, instances and
//! progress events. Nothing here ever carries a password back to the UI.

use serde::{Deserialize, Serialize};
use specta::Type;

pub use crate::audit::Engine;
use crate::db::{CommandError, ErrorCode};

/// How a local database is provided.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    /// A container QueryCraft creates and labels.
    Docker,
    /// A server installed with the OS package manager, after the user approved the commands.
    Native,
    /// A SQLite file in the app data directory.
    File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Windows,
    Macos,
    Linux,
}

impl Os {
    pub(crate) fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }
}

/// One pinned version of an engine. `id` is what the UI sends back; the image tag is exact, never
/// `latest`, so every instance of a version starts from the same bits.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VersionOption {
    pub id: &'static str,
    /// The exact image tag, e.g. `17.11`.
    pub tag: &'static str,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub engine: Engine,
    pub name: &'static str,
    pub description: &'static str,
    /// Empty for SQLite.
    pub versions: Vec<VersionOption>,
    /// `None` for SQLite.
    pub default_port: Option<u16>,
    pub default_user: &'static str,
    /// MySQL and MariaDB have a separate root account; Postgres' user is the superuser.
    pub has_root_password: bool,
}

/// Official Docker Hub images (the `library/` namespace).
pub(crate) fn image_repository(engine: Engine) -> Option<&'static str> {
    match engine {
        Engine::Postgres => Some("postgres"),
        Engine::Mysql => Some("mysql"),
        Engine::Mariadb => Some("mariadb"),
        Engine::Sqlite => None,
    }
}

pub(crate) const DEFAULT_DATABASE: &str = "querycraft_demo";

pub fn templates() -> Vec<Template> {
    let v = |id, tag| VersionOption { id, tag };
    vec![
        Template {
            engine: Engine::Postgres,
            name: "PostgreSQL",
            description: "General-purpose relational database with rich SQL and extensions.",
            versions: vec![v("17", "17.11"), v("16", "16.15")],
            default_port: Some(5432),
            default_user: "querycraft",
            has_root_password: false,
        },
        Template {
            engine: Engine::Mysql,
            name: "MySQL",
            description: "The widely deployed open-source relational database.",
            versions: vec![v("8.4", "8.4.13"), v("8.0", "8.0.46")],
            default_port: Some(3306),
            default_user: "querycraft",
            has_root_password: true,
        },
        Template {
            engine: Engine::Mariadb,
            name: "MariaDB",
            description: "Community fork of MySQL, compatible with its clients and SQL.",
            versions: vec![v("11.4", "11.4.13"), v("10.11", "10.11.19")],
            // 3307, so it can run next to a MySQL on 3306
            default_port: Some(3307),
            default_user: "querycraft",
            has_root_password: true,
        },
        Template {
            engine: Engine::Sqlite,
            name: "SQLite",
            description: "A single file on this machine. No server, nothing to install.",
            versions: Vec::new(),
            default_port: None,
            default_user: "",
            has_root_password: false,
        },
    ]
}

pub(crate) fn template(engine: Engine) -> Template {
    templates()
        .into_iter()
        .find(|t| t.engine == engine)
        .expect("every engine has a template")
}

pub(crate) fn engine_name(engine: Engine) -> &'static str {
    match engine {
        Engine::Postgres => "PostgreSQL",
        Engine::Mysql => "MySQL",
        Engine::Mariadb => "MariaDB",
        Engine::Sqlite => "SQLite",
    }
}

/// What the configure step sends. Validated in Rust on every call (`validate`).
#[derive(Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalRequest {
    pub engine: Engine,
    pub provider: Provider,
    /// A `VersionOption::id` of the engine's template; ignored for SQLite.
    pub version: String,
    /// The database to create (SQLite: the file name, without `.db`).
    pub database: String,
    pub user: String,
    pub password: String,
    /// MySQL/MariaDB root, or the native installer's admin password where one is needed.
    pub root_password: String,
    pub port: u16,
    /// Docker only; empty picks `querycraft-<engine>-<id>`.
    pub container_name: String,
    pub sample_data: bool,
    /// Native only: the `consentToken` of the plan whose commands the user approved.
    pub consent: Option<String>,
}

/// How the instance will be provided, for the review step and the native consent dialog.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalPlan {
    pub engine: Engine,
    pub provider: Provider,
    /// The exact version, e.g. `17.11`, or what the package manager installs.
    pub version: String,
    pub image: Option<String>,
    pub host: String,
    pub port: Option<u16>,
    pub port_free: bool,
    /// The next free port after `port`, when it isn't free.
    pub suggested_port: Option<u16>,
    pub database: String,
    pub user: Option<String>,
    pub container_name: Option<String>,
    /// The volume name, the data directory, or the SQLite file.
    pub storage: String,
    pub sample_data: bool,
    pub native: Option<NativePlan>,
    pub warnings: Vec<String>,
}

/// The exact commands a native install runs, as shown in the consent dialog (passwords masked).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NativePlan {
    /// winget, brew, apt-get, dnf, pacman or zypper; `None` when no supported one was found.
    pub manager: Option<String>,
    pub commands: Vec<String>,
    /// True when a command asks for administrator rights (UAC, pkexec).
    pub elevated: bool,
    /// False when QueryCraft can't run this safely here: `commands` are then manual steps.
    pub supported: bool,
    /// Whether the admin password field applies (the installer sets it).
    pub needs_root_password: bool,
    pub service: Option<String>,
    pub notes: Vec<String>,
    /// Sent back in `LocalRequest::consent`; ties the approval to these exact commands.
    pub consent_token: String,
    /// What to run to uninstall it later (QueryCraft doesn't uninstall).
    pub uninstall: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum InstanceStatus {
    Creating,
    Running,
    /// Running, waiting for its health check to pass.
    Starting,
    Stopped,
    Failed,
    /// The container was removed; its data volume is kept.
    Removed,
    /// The container or file is gone, and QueryCraft didn't remove it.
    Missing,
    /// Docker isn't reachable right now, so the state can't be read.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SampleState {
    Off,
    Loaded,
    Failed,
}

/// A database QueryCraft created, tracked in `local_instances.json`. No secrets.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalInstance {
    pub id: String,
    pub name: String,
    pub engine: Engine,
    pub version: String,
    pub provider: Provider,
    pub container_id: Option<String>,
    pub container_name: Option<String>,
    pub volume: Option<String>,
    /// SQLite file, or the native server's data directory when known.
    pub data_path: Option<String>,
    /// Native: the service (brew formula, systemd unit, Windows service).
    pub service: Option<String>,
    pub host: String,
    pub port: Option<u16>,
    pub database: String,
    pub user: Option<String>,
    /// Unix ms.
    #[specta(type = specta_typescript::Number)]
    pub created_at: i64,
    pub status: InstanceStatus,
    /// Docker instances carry QueryCraft's labels; only those are ever changed.
    pub managed: bool,
    pub saved_connection_id: Option<String>,
    pub sample_data: SampleState,
    /// Native: the manual uninstall command.
    pub uninstall: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    CheckingRuntime,
    PullingImage,
    CreatingStorage,
    CreatingContainer,
    Installing,
    Starting,
    WaitingForHealth,
    CreatingDatabase,
    InitializingSampleData,
    Validating,
    RegisteringConnection,
    Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum StageState {
    Running,
    Done,
    Skipped,
    Failed,
    /// A line of output from the running stage (password-masked).
    Output,
}

/// Sent while `create_local_database` runs. Real stage transitions only; no percentages.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct LocalProgress {
    pub provisioning_id: String,
    pub stage: Stage,
    pub state: StageState,
    pub message: Option<String>,
    /// Whether cancelling is safe from here on.
    pub cancellable: bool,
}

/// What `create_local_database` returns once the connection is registered.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalCreated {
    pub instance: LocalInstance,
    pub connection_id: String,
    pub connection_label: String,
    /// Set when the sample data failed; the instance and connection are kept.
    pub sample_error: Option<String>,
    /// The commented example queries, when sample data loaded.
    pub starter_sql: Option<String>,
}

/// Where an existing database is, for "connect existing" and connection tests.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LocalTarget {
    Container { id: String },
    Native { engine: Engine, port: u16 },
    Instance { id: String },
}

/// Credentials the user typed when they couldn't be recovered.
#[derive(Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalLogin {
    pub user: String,
    pub password: String,
    pub database: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TestOutcome {
    pub ok: bool,
    pub message: String,
    /// False when the password couldn't be recovered and has to be typed.
    pub needs_credentials: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SampleOutcome {
    pub instance: LocalInstance,
    pub starter_sql: String,
}

// --- Validation ------------------------------------------------------------------------------

fn invalid(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorCode::InvalidInput, message)
}

/// Database and user names: a letter or `_`, then letters, digits and `_`. They go into SQL and
/// container env vars, so nothing that needs quoting.
pub(crate) fn check_identifier(value: &str, field: &str, max: usize) -> Result<(), CommandError> {
    let mut chars = value.chars();
    let ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && value.len() <= max;
    if ok {
        Ok(())
    } else {
        Err(invalid(format!(
            "{field} must start with a letter or _ and use only letters, digits and _ (at most {max} characters)."
        )))
    }
}

/// Container and volume names: `[a-zA-Z0-9_-]`, starting with a letter or digit.
pub(crate) fn check_resource_name(value: &str, field: &str) -> Result<(), CommandError> {
    let mut chars = value.chars();
    let ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && value.len() <= 63;
    if ok {
        Ok(())
    } else {
        Err(invalid(format!(
            "{field} must start with a letter or digit and use only letters, digits, _ and - (at most 63 characters)."
        )))
    }
}

pub(crate) fn check_port(port: u16) -> Result<(), CommandError> {
    if port < 1024 {
        return Err(invalid("Port must be between 1024 and 65535."));
    }
    Ok(())
}

/// Passwords: 8–128 printable ASCII characters without spaces, quotes, `\`, `` ` `` or `$`. They
/// end up in SQL literals and installer arguments, where those characters would need escaping.
pub(crate) fn check_password(value: &str, field: &str) -> Result<(), CommandError> {
    if !(8..=128).contains(&value.len()) {
        return Err(invalid(format!("{field} must be 8 to 128 characters.")));
    }
    let bad = |c: char| !c.is_ascii_graphic() || matches!(c, '\'' | '"' | '\\' | '`' | '$');
    if value.chars().any(bad) {
        return Err(invalid(format!(
            "{field} can’t contain spaces, quotes, \\, ` or $."
        )));
    }
    Ok(())
}

/// The pinned version for `id`, or an error if it isn't on the allow-list.
pub(crate) fn pinned_version(engine: Engine, id: &str) -> Result<VersionOption, CommandError> {
    template(engine)
        .versions
        .into_iter()
        .find(|v| v.id == id)
        .ok_or_else(|| {
            invalid(format!(
                "{} {id} isn’t a supported version.",
                engine_name(engine)
            ))
        })
}

impl LocalRequest {
    /// Checks every field the chosen engine and provider use.
    pub(crate) fn validate(&self) -> Result<(), CommandError> {
        check_identifier(&self.database, "Database name", 63)?;
        if self.engine == Engine::Sqlite {
            if self.provider != Provider::File {
                return Err(invalid("SQLite is created as a file."));
            }
            return Ok(());
        }
        if self.provider == Provider::File {
            return Err(invalid("Only SQLite is created as a file."));
        }
        pinned_version(self.engine, &self.version)?;
        // MySQL user names are at most 32 characters
        check_identifier(&self.user, "User", 32)?;
        if self.engine != Engine::Postgres && self.user.eq_ignore_ascii_case("root") {
            return Err(invalid(
                "Pick a user other than root: root is the admin account.",
            ));
        }
        check_password(&self.password, "Password")?;
        if template(self.engine).has_root_password && self.provider == Provider::Docker {
            check_password(&self.root_password, "Root password")?;
        }
        check_port(self.port)?;
        if !self.container_name.is_empty() {
            check_resource_name(&self.container_name, "Container name")?;
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn request(engine: Engine, provider: Provider) -> LocalRequest {
        LocalRequest {
            engine,
            provider,
            version: template(engine)
                .versions
                .first()
                .map_or(String::new(), |v| v.id.to_owned()),
            database: DEFAULT_DATABASE.into(),
            user: "querycraft".into(),
            password: "Gq7-xR2_pL9.mZ".into(),
            root_password: "Rt5-aB8_cD1.eF".into(),
            port: 5544,
            container_name: String::new(),
            sample_data: true,
            consent: None,
        }
    }

    #[test]
    fn accepts_a_valid_request_for_every_engine() {
        for engine in [Engine::Postgres, Engine::Mysql, Engine::Mariadb] {
            request(engine, Provider::Docker).validate().unwrap();
        }
        request(Engine::Sqlite, Provider::File).validate().unwrap();
    }

    #[test]
    fn rejects_bad_values() {
        let check = |f: &dyn Fn(&mut LocalRequest)| {
            let mut r = request(Engine::Mysql, Provider::Docker);
            f(&mut r);
            r.validate().unwrap_err()
        };
        check(&|r| r.database = "shop; DROP".into());
        check(&|r| r.database = "1shop".into());
        check(&|r| r.database = String::new());
        check(&|r| r.user = "root".into());
        check(&|r| r.user = "a".repeat(33));
        check(&|r| r.password = "short".into());
        check(&|r| r.password = "has space in it".into());
        check(&|r| r.password = "quote'inside".into());
        check(&|r| r.root_password = "x".into());
        check(&|r| r.port = 80);
        check(&|r| r.version = "latest".into());
        check(&|r| r.container_name = "../etc".into());
        check(&|r| r.container_name = "-flag".into());
        check(&|r| r.provider = Provider::File);
    }

    #[test]
    fn every_pinned_tag_is_exact() {
        for t in templates() {
            for v in &t.versions {
                assert_ne!(v.tag, "latest");
                // A minor (and patch) release under the major, never the floating major tag
                assert!(
                    v.tag.starts_with(&format!("{}.", v.id)),
                    "{} {}",
                    t.name,
                    v.tag
                );
            }
        }
    }
}
