//! The Docker provider, through the `docker` CLI.
//!
//! Why the CLI and not the `bollard` crate: the CLI already knows how to reach the daemon on
//! every OS (Docker Desktop's named pipe and context on Windows/macOS, the socket and its group
//! permissions on Linux, rootless and remote contexts), and the user can run the exact same
//! commands to check what QueryCraft did. bollard would need its own context resolution and adds
//! a large dependency tree. Every call is an argument vector (see process.rs).
//!
//! Safety: discovery reads every container, but only containers and volumes that carry
//! `com.querycraft.managed=true` and the instance's id label are ever started, stopped or removed.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::process::{self, Cancel, Cmd, RunError};
use super::types::{Engine, Os};
use crate::db::{CommandError, ErrorCode};

pub(crate) const LABEL_MANAGED: &str = "com.querycraft.managed";
pub(crate) const LABEL_INSTANCE: &str = "com.querycraft.instance-id";
pub(crate) const LABEL_DATABASE: &str = "com.querycraft.database";

const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const PULL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DockerProblem {
    NotInstalled,
    DaemonStopped,
    PermissionDenied,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerStatus {
    pub installed: bool,
    pub client_version: Option<String>,
    pub daemon_running: bool,
    pub server_version: Option<String>,
    /// e.g. "Docker Desktop 4.94.0"
    pub platform: Option<String>,
    pub compose_version: Option<String>,
    pub problem: Option<DockerProblem>,
    /// The CLI's own error, when there's a problem.
    pub detail: Option<String>,
    pub os: Os,
    /// Docker's official install page for this OS.
    pub install_url: &'static str,
}

pub(crate) fn install_url(os: Os) -> &'static str {
    match os {
        Os::Windows => "https://docs.docker.com/desktop/setup/install/windows-install/",
        Os::Macos => "https://docs.docker.com/desktop/setup/install/mac-install/",
        Os::Linux => "https://docs.docker.com/engine/install/",
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct VersionJson {
    client: Option<VersionPart>,
    server: Option<ServerPart>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct VersionPart {
    version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ServerPart {
    version: String,
    platform: Option<PlatformPart>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct PlatformPart {
    name: String,
}

/// Reads `docker version --format json`. With the daemon down the CLI still prints the client
/// half (`"Server": null`), exits non-zero and explains on stderr.
pub(crate) fn parse_version(stdout: &str, stderr: &str, os: Os) -> DockerStatus {
    let parsed: Option<VersionJson> = stdout
        .lines()
        .find(|l| l.trim_start().starts_with('{'))
        .and_then(|l| serde_json::from_str(l).ok());
    let client = parsed.as_ref().and_then(|v| v.client.as_ref());
    let server = parsed.as_ref().and_then(|v| v.server.as_ref());
    let problem = match server {
        Some(_) => None,
        None if stderr.to_ascii_lowercase().contains("permission denied") => {
            Some(DockerProblem::PermissionDenied)
        }
        None => Some(DockerProblem::DaemonStopped),
    };
    DockerStatus {
        installed: true,
        client_version: client.map(|c| c.version.clone()),
        daemon_running: server.is_some(),
        server_version: server.map(|s| s.version.clone()),
        platform: server.and_then(|s| s.platform.as_ref().map(|p| p.name.clone())),
        compose_version: None,
        problem,
        detail: problem.map(|_| first_error_line(stderr)),
        os,
        install_url: install_url(os),
    }
}

fn first_error_line(stderr: &str) -> String {
    stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("Docker didn’t respond.")
        .to_owned()
}

/// Turns Docker's stderr into an error code and a message that says what to do next.
pub(crate) fn docker_error(stderr: &str, action: &str) -> CommandError {
    let lower = stderr.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));
    let detail = stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("no output")
        .to_owned();
    let (code, hint) = if has(&[
        "permission denied while trying to connect",
        "docker.sock: connect: permission denied",
    ]) {
        (
            ErrorCode::DockerPermission,
            "Docker refused this user. On Linux, add yourself to the docker group (sudo usermod -aG docker $USER) and sign in again.",
        )
    } else if has(&[
        "cannot connect to the docker daemon",
        "error during connect",
        "is the docker daemon running",
        "dockerdesktoplinuxengine",
    ]) {
        (
            ErrorCode::DockerStopped,
            "Docker isn’t running. Start Docker Desktop (or the docker service) and try again.",
        )
    } else if has(&["no space left on device"]) {
        (
            ErrorCode::DiskFull,
            "The disk Docker uses is full. Free some space (docker system df shows what uses it) and try again.",
        )
    } else if has(&[
        "port is already allocated",
        "address already in use",
        "ports are not available",
        "only one usage of each socket address",
    ]) {
        (
            ErrorCode::PortInUse,
            "That port is already in use. Pick another port.",
        )
    } else if has(&["is already in use by container"]) {
        (
            ErrorCode::InvalidInput,
            "A container with that name already exists. Pick another container name.",
        )
    } else if has(&["pull access denied", "manifest unknown", "manifest for"]) {
        (
            ErrorCode::ImagePullFailed,
            "Docker Hub doesn’t have that image tag. Pick another version.",
        )
    } else if has(&[
        "tls handshake timeout",
        "i/o timeout",
        "no such host",
        "dial tcp",
        "connection refused",
        "network is unreachable",
        "temporary failure in name resolution",
        "context deadline exceeded",
    ]) {
        (
            ErrorCode::ImagePullFailed,
            "Couldn’t reach Docker Hub. Check your internet connection or proxy, then try again.",
        )
    } else if has(&["permission denied", "access is denied"]) {
        (
            ErrorCode::PermissionDenied,
            "Docker was refused access. Check Docker’s file sharing and permissions settings.",
        )
    } else {
        (ErrorCode::ProvisionFailed, "Docker reported an error.")
    };
    CommandError::new(code, format!("{action} failed: {detail}. {hint}"))
}

fn run_error(error: RunError, action: &str) -> CommandError {
    match error {
        RunError::NotFound => not_installed(),
        RunError::Cancelled => CommandError::new(ErrorCode::Cancelled, "Cancelled."),
        RunError::TimedOut => CommandError::new(
            ErrorCode::StartupTimeout,
            format!("{action} took too long. Check that Docker is responding and try again."),
        ),
        RunError::Io(e) => {
            CommandError::new(ErrorCode::ProvisionFailed, format!("{action} failed: {e}"))
        }
    }
}

fn not_installed() -> CommandError {
    CommandError::new(
        ErrorCode::DockerUnavailable,
        "Docker isn’t installed. Install Docker Desktop (Windows, macOS) or Docker Engine (Linux), or use SQLite or a native install instead.",
    )
}

// --- Images ----------------------------------------------------------------------------------

/// The engine an image runs, from its repository's last path segment, so registry and namespace
/// prefixes (`docker.io/library/postgres`, `registry:5000/team/mysql`) and tags or digests
/// don't matter. Returns the tag too, when there is one.
pub(crate) fn engine_of_image(image: &str) -> Option<(Engine, Option<String>)> {
    let without_digest = image.split('@').next().unwrap_or(image);
    let (path, tag) = match without_digest.rsplit_once(':') {
        // A ':' before the last '/' is a registry port, not a tag
        Some((path, tag)) if !tag.contains('/') => (path, Some(tag.to_owned())),
        _ => (without_digest, None),
    };
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let engine = match name.as_str() {
        "postgres" | "postgresql" | "postgis" => Engine::Postgres,
        "mysql" | "mysql-server" => Engine::Mysql,
        "mariadb" => Engine::Mariadb,
        _ => return None,
    };
    Some((engine, tag))
}

/// The server version from the image's own env (`PG_VERSION=17.6-1.pgdg…`,
/// `MARIADB_VERSION=1:11.4.8+maria~…`), else the tag.
fn version_of(engine: Engine, env: &HashMap<String, String>, tag: Option<&str>) -> Option<String> {
    let key = match engine {
        Engine::Postgres => "PG_VERSION",
        Engine::Mysql => "MYSQL_VERSION",
        Engine::Mariadb => "MARIADB_VERSION",
        Engine::Sqlite => return None,
    };
    let from_env = env.get(key).map(|v| {
        let v = v.split_once(':').map_or(v.as_str(), |(_, rest)| rest);
        v.split(['-', '+', '~']).next().unwrap_or(v).to_owned()
    });
    from_env.or_else(|| tag.filter(|t| *t != "latest").map(str::to_owned))
}

// --- Containers ------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct Inspect {
    #[serde(rename = "Id")]
    pub id: String,
    pub name: String,
    pub config: InspectConfig,
    pub state: InspectState,
    pub host_config: HostConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct InspectConfig {
    pub image: String,
    #[serde(default)]
    pub env: Option<Vec<String>>,
    #[serde(default)]
    pub labels: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct InspectState {
    pub status: String,
    pub health: Option<Health>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct Health {
    pub status: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct HostConfig {
    #[serde(default)]
    pub port_bindings: Option<HashMap<String, Option<Vec<Binding>>>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct Binding {
    #[serde(default)]
    pub host_ip: String,
    #[serde(default)]
    pub host_port: String,
}

impl Inspect {
    pub(crate) fn short_id(&self) -> &str {
        &self.id[..self.id.len().min(12)]
    }

    pub(crate) fn display_name(&self) -> &str {
        self.name.trim_start_matches('/')
    }

    pub(crate) fn label(&self, key: &str) -> Option<&str> {
        self.config.labels.as_ref()?.get(key).map(String::as_str)
    }

    pub(crate) fn env(&self) -> HashMap<String, String> {
        self.config
            .env
            .iter()
            .flatten()
            .filter_map(|e| e.split_once('='))
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect()
    }

    pub(crate) fn is_managed(&self) -> bool {
        self.label(LABEL_MANAGED) == Some("true")
    }

    /// The host side of the engine's port mapping (5432 or 3306 in the container).
    pub(crate) fn host_port(&self, engine: Engine) -> Option<(String, u16)> {
        let inner = match engine {
            Engine::Postgres => "5432/tcp",
            _ => "3306/tcp",
        };
        let bindings = self
            .host_config
            .port_bindings
            .as_ref()?
            .get(inner)?
            .as_ref()?;
        bindings.iter().find_map(|b| {
            let port = b.host_port.parse().ok()?;
            Some((b.host_ip.clone(), port))
        })
    }

    pub(crate) fn health(&self) -> Option<&str> {
        self.state.health.as_ref().map(|h| h.status.as_str())
    }

    /// Values of every `*PASSWORD*` variable, to mask them in logs. Never sent anywhere.
    pub(crate) fn secrets(&self) -> Vec<String> {
        self.env()
            .into_iter()
            .filter(|(k, v)| k.contains("PASSWORD") && !k.ends_with("_FILE") && !v.is_empty())
            .map(|(_, v)| v)
            .collect()
    }
}

/// A login recovered from a container's env. The password stays in Rust: it is used to test and
/// save the connection, never shown or logged.
#[derive(Debug, Clone)]
pub(crate) struct EnvLogin {
    pub user: String,
    pub database: String,
    /// `None` when the image was given a password file or a random root password.
    pub password: Option<String>,
}

pub(crate) fn login_from_env(engine: Engine, env: &HashMap<String, String>) -> EnvLogin {
    let get = |k: &str| env.get(k).filter(|v| !v.is_empty()).cloned();
    match engine {
        Engine::Postgres => {
            let user = get("POSTGRES_USER").unwrap_or_else(|| "postgres".into());
            let trust = env
                .get("POSTGRES_HOST_AUTH_METHOD")
                .is_some_and(|m| m == "trust");
            EnvLogin {
                database: get("POSTGRES_DB").unwrap_or_else(|| user.clone()),
                password: get("POSTGRES_PASSWORD").or_else(|| trust.then(String::new)),
                user,
            }
        }
        Engine::Mysql | Engine::Mariadb => {
            // MariaDB images read MARIADB_* first and accept the MYSQL_* names too
            let var = |name: &str| {
                let mariadb = (engine == Engine::Mariadb)
                    .then(|| get(&format!("MARIADB_{name}")))
                    .flatten();
                mariadb.or_else(|| get(&format!("MYSQL_{name}")))
            };
            let database = var("DATABASE").unwrap_or_default();
            if let (Some(user), Some(password)) = (var("USER"), var("PASSWORD")) {
                return EnvLogin {
                    user,
                    database,
                    password: Some(password),
                };
            }
            let empty_root =
                var("ALLOW_EMPTY_PASSWORD").is_some() || var("ALLOW_EMPTY_ROOT_PASSWORD").is_some();
            EnvLogin {
                user: "root".into(),
                database,
                password: var("ROOT_PASSWORD").or_else(|| empty_root.then(String::new)),
            }
        }
        Engine::Sqlite => EnvLogin {
            user: String::new(),
            database: String::new(),
            password: None,
        },
    }
}

/// A database container found on this machine, QueryCraft's or not.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub engine: Engine,
    pub version: Option<String>,
    /// Docker's state: running, exited, created, paused, restarting, dead.
    pub state: String,
    pub health: Option<String>,
    pub host_port: Option<u16>,
    pub host_ip: Option<String>,
    pub managed: bool,
    pub instance_id: Option<String>,
    pub database: Option<String>,
    pub user: Option<String>,
    /// Whether a password could be recovered from the container's env (never the password).
    pub password_known: bool,
}

pub(crate) fn describe(inspect: &Inspect) -> Option<DiscoveredContainer> {
    let (engine, tag) = engine_of_image(&inspect.config.image)?;
    let env = inspect.env();
    let login = login_from_env(engine, &env);
    let port = inspect.host_port(engine);
    Some(DiscoveredContainer {
        id: inspect.short_id().to_owned(),
        name: inspect.display_name().to_owned(),
        image: inspect.config.image.clone(),
        engine,
        version: version_of(engine, &env, tag.as_deref()),
        state: inspect.state.status.clone(),
        health: inspect.health().map(str::to_owned),
        host_port: port.as_ref().map(|(_, p)| *p),
        host_ip: port.map(|(ip, _)| ip).filter(|ip| !ip.is_empty()),
        managed: inspect.is_managed(),
        instance_id: inspect.label(LABEL_INSTANCE).map(str::to_owned),
        database: inspect
            .label(LABEL_DATABASE)
            .map(str::to_owned)
            .or_else(|| (!login.database.is_empty()).then(|| login.database.clone())),
        user: Some(login.user),
        password_known: login.password.is_some(),
    })
}

/// Lines of `docker ps -a --format json` whose image is a database engine; their ids.
pub(crate) fn candidate_ids(ps_output: &str) -> Vec<String> {
    #[derive(Deserialize)]
    struct Row {
        #[serde(rename = "ID")]
        id: String,
        #[serde(rename = "Image")]
        image: String,
    }
    ps_output
        .lines()
        .filter_map(|l| serde_json::from_str::<Row>(l).ok())
        .filter(|r| engine_of_image(&r.image).is_some())
        .map(|r| r.id)
        .collect()
}

pub(crate) fn parse_inspect(json: &str) -> Result<Vec<Inspect>, CommandError> {
    serde_json::from_str(json).map_err(|e| {
        CommandError::new(
            ErrorCode::ProvisionFailed,
            format!("Couldn’t read docker inspect output: {e}"),
        )
    })
}

/// Refuses anything without QueryCraft's labels for this instance: the guard in front of every
/// start, stop, restart and removal.
pub(crate) fn check_managed(
    labels: Option<&HashMap<String, String>>,
    instance_id: &str,
    what: &str,
) -> Result<(), CommandError> {
    let label = |k: &str| labels.and_then(|l| l.get(k)).map(String::as_str);
    if label(LABEL_MANAGED) == Some("true") && label(LABEL_INSTANCE) == Some(instance_id) {
        Ok(())
    } else {
        Err(CommandError::new(
            ErrorCode::NotManaged,
            format!(
                "The {what} isn’t one QueryCraft created for this instance, so it wasn’t touched."
            ),
        ))
    }
}

// --- Creating --------------------------------------------------------------------------------

/// Everything `docker create` needs, already validated.
pub(crate) struct ContainerSpec<'a> {
    pub instance_id: &'a str,
    pub engine: Engine,
    pub image: &'a str,
    pub name: &'a str,
    pub volume: &'a str,
    pub port: u16,
    pub database: &'a str,
    pub user: &'a str,
    pub password: &'a str,
    pub root_password: &'a str,
}

fn labels(instance_id: &str, database: &str) -> Vec<String> {
    [
        format!("{LABEL_MANAGED}=true"),
        format!("{LABEL_INSTANCE}={instance_id}"),
        format!("{LABEL_DATABASE}={database}"),
    ]
    .into_iter()
    .flat_map(|l| ["--label".to_owned(), l])
    .collect()
}

pub(crate) fn volume_args(instance_id: &str, database: &str, volume: &str) -> Vec<String> {
    let mut args = vec!["volume".to_owned(), "create".to_owned()];
    args.extend(labels(instance_id, database));
    args.push(volume.to_owned());
    args
}

/// `docker create` arguments, and the env values the child process gets. Secrets go in the
/// child's environment and the arguments only name them (`-e POSTGRES_PASSWORD`), so they never
/// show up in a process list.
pub(crate) fn create_args(spec: &ContainerSpec) -> (Vec<String>, Vec<(String, String)>) {
    let (data_dir, inner_port, health) = match spec.engine {
        Engine::Postgres => (
            "/var/lib/postgresql/data",
            5432,
            // -h: only the real server; during init Postgres listens on its socket alone
            format!(
                "pg_isready -h 127.0.0.1 -U {} -d {}",
                spec.user, spec.database
            ),
        ),
        // ping exits 0 even when the login is refused, so it needs no password; the init
        // server runs with --skip-networking, so TCP answers only once the real one is up
        Engine::Mysql => (
            "/var/lib/mysql",
            3306,
            "mysqladmin ping -h 127.0.0.1 --silent".to_owned(),
        ),
        Engine::Mariadb => (
            "/var/lib/mysql",
            3306,
            "mariadb-admin ping -h 127.0.0.1 --silent".to_owned(),
        ),
        Engine::Sqlite => unreachable!("SQLite has no container"),
    };
    let env: Vec<(String, String)> = match spec.engine {
        Engine::Postgres => vec![
            ("POSTGRES_USER", spec.user),
            ("POSTGRES_PASSWORD", spec.password),
            ("POSTGRES_DB", spec.database),
        ],
        Engine::Mysql => vec![
            ("MYSQL_ROOT_PASSWORD", spec.root_password),
            ("MYSQL_USER", spec.user),
            ("MYSQL_PASSWORD", spec.password),
            ("MYSQL_DATABASE", spec.database),
        ],
        Engine::Mariadb => vec![
            ("MARIADB_ROOT_PASSWORD", spec.root_password),
            ("MARIADB_USER", spec.user),
            ("MARIADB_PASSWORD", spec.password),
            ("MARIADB_DATABASE", spec.database),
        ],
        Engine::Sqlite => unreachable!(),
    }
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();

    let mut args: Vec<String> = ["create", "--name", spec.name].map(str::to_owned).to_vec();
    args.extend(labels(spec.instance_id, spec.database));
    for (key, _) in &env {
        args.extend(["-e".to_owned(), key.clone()]);
    }
    args.extend([
        // Loopback only: never reachable from the network
        "--publish".to_owned(),
        format!("127.0.0.1:{}:{inner_port}", spec.port),
        "--volume".to_owned(),
        format!("{}:{data_dir}", spec.volume),
        "--restart".to_owned(),
        "unless-stopped".to_owned(),
        "--health-cmd".to_owned(),
        health,
        "--health-interval".to_owned(),
        "2s".to_owned(),
        "--health-timeout".to_owned(),
        "5s".to_owned(),
        "--health-retries".to_owned(),
        "90".to_owned(),
        "--health-start-period".to_owned(),
        "5s".to_owned(),
        spec.image.to_owned(),
    ]);
    (args, env)
}

// --- The CLI ---------------------------------------------------------------------------------

pub(crate) struct Docker {
    program: PathBuf,
}

fn docker_locations() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        dirs.push(r"C:\Program Files\Docker\Docker\resources\bin".into());
    } else {
        dirs.extend(
            [
                "/usr/local/bin",
                "/opt/homebrew/bin",
                "/usr/bin",
                "/Applications/Docker.app/Contents/Resources/bin",
            ]
            .map(PathBuf::from),
        );
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join(".docker/bin"));
        }
    }
    dirs
}

impl Docker {
    pub(crate) fn locate() -> Option<Self> {
        process::find_program("docker", &docker_locations()).map(|program| Self { program })
    }

    /// Like `locate`, but an error that says how to get Docker.
    pub(crate) fn require() -> Result<Self, CommandError> {
        Self::locate().ok_or_else(not_installed)
    }

    fn cmd(&self, args: Vec<String>, timeout: Duration) -> Cmd {
        Cmd {
            program: self.program.clone(),
            args,
            env: Vec::new(),
            stdin: None,
            timeout,
        }
    }

    /// Runs a docker command, mapping a failure to a structured error.
    async fn exec(
        &self,
        args: &[&str],
        action: &str,
        timeout: Duration,
    ) -> Result<String, CommandError> {
        let cmd = self.cmd(args.iter().map(|a| (*a).to_owned()).collect(), timeout);
        let out = process::output(&cmd)
            .await
            .map_err(|e| run_error(e, action))?;
        if out.success {
            Ok(out.stdout)
        } else {
            Err(docker_error(&out.stderr, action))
        }
    }

    pub(crate) async fn status() -> DockerStatus {
        let os = Os::current();
        let Some(docker) = Self::locate() else {
            return DockerStatus {
                installed: false,
                client_version: None,
                daemon_running: false,
                server_version: None,
                platform: None,
                compose_version: None,
                problem: Some(DockerProblem::NotInstalled),
                detail: None,
                os,
                install_url: install_url(os),
            };
        };
        let version = docker.cmd(
            vec!["version".into(), "--format".into(), "json".into()],
            STATUS_TIMEOUT,
        );
        let compose = docker.cmd(
            vec!["compose".into(), "version".into(), "--short".into()],
            STATUS_TIMEOUT,
        );
        let (version, compose) = tokio::join!(process::output(&version), process::output(&compose));
        let mut status = match version {
            Ok(out) => parse_version(&out.stdout, &out.stderr, os),
            Err(RunError::TimedOut) => DockerStatus {
                detail: Some("Docker didn’t answer within 10 seconds.".into()),
                ..parse_version("", "", os)
            },
            Err(_) => DockerStatus {
                installed: false,
                problem: Some(DockerProblem::NotInstalled),
                ..parse_version("", "", os)
            },
        };
        status.compose_version = compose
            .ok()
            .filter(|o| o.success)
            .map(|o| o.stdout.trim().trim_start_matches('v').to_owned())
            .filter(|v| !v.is_empty());
        status
    }

    /// Every container whose image is a database engine, inspected.
    pub(crate) async fn database_containers(&self) -> Result<Vec<Inspect>, CommandError> {
        let ps = self
            .exec(
                &["ps", "-a", "--no-trunc", "--format", "json"],
                "Listing containers",
                STATUS_TIMEOUT,
            )
            .await?;
        let ids = candidate_ids(&ps);
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut args = vec!["inspect", "--type", "container", "--format", "json"];
        args.extend(ids.iter().map(String::as_str));
        let json = self
            .exec(&args, "Inspecting containers", STATUS_TIMEOUT)
            .await?;
        parse_inspect(&json)
    }

    /// `None` when there is no such container.
    pub(crate) async fn inspect(&self, id: &str) -> Result<Option<Inspect>, CommandError> {
        let cmd = self.cmd(
            ["inspect", "--type", "container", "--format", "json", id]
                .map(str::to_owned)
                .to_vec(),
            STATUS_TIMEOUT,
        );
        let out = process::output(&cmd)
            .await
            .map_err(|e| run_error(e, "Inspecting the container"))?;
        if out.success {
            return Ok(parse_inspect(&out.stdout)?.into_iter().next());
        }
        if out.stderr.to_ascii_lowercase().contains("no such") {
            return Ok(None);
        }
        Err(docker_error(&out.stderr, "Inspecting the container"))
    }

    /// The labels of a volume, `None` when it doesn't exist.
    pub(crate) async fn volume_labels(
        &self,
        name: &str,
    ) -> Result<Option<HashMap<String, String>>, CommandError> {
        #[derive(Deserialize)]
        struct Volume {
            #[serde(rename = "Labels")]
            labels: Option<HashMap<String, String>>,
        }
        let cmd = self.cmd(
            ["volume", "inspect", "--format", "json", name]
                .map(str::to_owned)
                .to_vec(),
            STATUS_TIMEOUT,
        );
        let out = process::output(&cmd)
            .await
            .map_err(|e| run_error(e, "Inspecting the volume"))?;
        if !out.success {
            if out.stderr.to_ascii_lowercase().contains("no such") {
                return Ok(None);
            }
            return Err(docker_error(&out.stderr, "Inspecting the volume"));
        }
        let volumes: Vec<Volume> = serde_json::from_str(&out.stdout).map_err(|e| {
            CommandError::new(
                ErrorCode::ProvisionFailed,
                format!("Couldn’t read the volume: {e}"),
            )
        })?;
        Ok(Some(
            volumes
                .into_iter()
                .next()
                .and_then(|v| v.labels)
                .unwrap_or_default(),
        ))
    }

    pub(crate) async fn image_present(&self, image: &str) -> bool {
        let cmd = self.cmd(
            ["image", "inspect", "--format", "{{.Id}}", image]
                .map(str::to_owned)
                .to_vec(),
            STATUS_TIMEOUT,
        );
        process::output(&cmd).await.is_ok_and(|o| o.success)
    }

    pub(crate) async fn pull(
        &self,
        image: &str,
        cancel: &Cancel,
        on_line: impl FnMut(&str),
    ) -> Result<(), CommandError> {
        let cmd = self.cmd(vec!["pull".into(), image.into()], PULL_TIMEOUT);
        let out = process::run(&cmd, Some(cancel), on_line)
            .await
            .map_err(|e| run_error(e, "Pulling the image"))?;
        if out.success {
            Ok(())
        } else {
            Err(docker_error(&out.stderr, "Pulling the image"))
        }
    }

    pub(crate) async fn create_volume(
        &self,
        instance_id: &str,
        database: &str,
        volume: &str,
    ) -> Result<(), CommandError> {
        let args = volume_args(instance_id, database, volume);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        self.exec(&args, "Creating the volume", LIFECYCLE_TIMEOUT)
            .await
            .map(drop)
    }

    /// Creates the container (not started); returns its id.
    pub(crate) async fn create(&self, spec: &ContainerSpec<'_>) -> Result<String, CommandError> {
        let (args, env) = create_args(spec);
        let mut cmd = self.cmd(args, LIFECYCLE_TIMEOUT);
        cmd.env = env;
        let out = process::output(&cmd)
            .await
            .map_err(|e| run_error(e, "Creating the container"))?;
        if !out.success {
            return Err(docker_error(&out.stderr, "Creating the container"));
        }
        Ok(out.stdout.trim().to_owned())
    }

    /// start, stop or restart a container. Callers check `check_managed` first.
    pub(crate) async fn lifecycle(&self, verb: &str, id: &str) -> Result<(), CommandError> {
        let action = match verb {
            "start" => "Starting the container",
            "stop" => "Stopping the container",
            _ => "Restarting the container",
        };
        self.exec(&[verb, id], action, LIFECYCLE_TIMEOUT)
            .await
            .map(drop)
    }

    /// The last `lines` of the container's log, stdout and stderr together, unmasked.
    pub(crate) async fn logs(&self, id: &str, lines: u32) -> Result<String, CommandError> {
        let tail = lines.to_string();
        let cmd = self.cmd(
            ["logs", "--tail", &tail, id].map(str::to_owned).to_vec(),
            STATUS_TIMEOUT,
        );
        let out = process::output(&cmd)
            .await
            .map_err(|e| run_error(e, "Reading the logs"))?;
        if !out.success {
            return Err(docker_error(&out.stderr, "Reading the logs"));
        }
        // Databases log to stderr; merge in order of arrival isn't available, stderr first is
        // closest to what `docker logs` shows for these images
        Ok(format!("{}{}", out.stderr, out.stdout))
    }

    pub(crate) async fn remove_container(&self, id: &str) -> Result<(), CommandError> {
        self.exec(
            &["rm", "--force", id],
            "Removing the container",
            LIFECYCLE_TIMEOUT,
        )
        .await
        .map(drop)
    }

    pub(crate) async fn remove_volume(&self, name: &str) -> Result<(), CommandError> {
        self.exec(
            &["volume", "rm", name],
            "Deleting the volume",
            LIFECYCLE_TIMEOUT,
        )
        .await
        .map(drop)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const VERSION_UP: &str = r#"{"Client":{"Version":"29.8.2","ApiVersion":"1.56","Os":"windows","Arch":"amd64","Context":"desktop-linux"},"Server":{"Platform":{"Name":"Docker Desktop 4.94.0 (241994)"},"Version":"29.8.2","ApiVersion":"1.56","Os":"linux"}}"#;
    const VERSION_DOWN: &str = r#"{"Client":{"Version":"29.8.2","ApiVersion":"1.56","Os":"windows","Arch":"amd64","Context":"desktop-linux"},"Server":null}"#;
    const DOWN_STDERR: &str = "error during connect: Get \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/version\": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.";
    const LINUX_PERMISSION: &str = "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get \"http://%2Fvar%2Frun%2Fdocker.sock/v1.47/version\": dial unix /var/run/docker.sock: connect: permission denied";

    pub(crate) const PS: &str = concat!(
        r#"{"ID":"4155df1034cd","Image":"pgsty/minio:latest","Names":"s3","State":"running"}"#,
        "\n",
        r#"{"ID":"8861d95a7116","Image":"postgres:17","Names":"postgres","State":"running"}"#,
        "\n",
        r#"{"ID":"aa11bb22cc33","Image":"docker.io/library/mariadb:11.4.13@sha256:abc","Names":"qc","State":"exited"}"#,
        "\n",
        r#"{"ID":"dd44ee55ff66","Image":"redis:7-alpine","Names":"redis","State":"running"}"#,
        "\n",
    );

    pub(crate) const INSPECT: &str = r#"[
      {"Id":"8861d95a71167b2d5c400149e7a92b0991321dee18e66ff86b7b5d2ee1491f0e","Name":"/postgres",
       "State":{"Status":"running","Running":true},
       "Config":{"Image":"postgres:17","Env":["POSTGRES_PASSWORD=pg-secret-1","POSTGRES_USER=app","PG_VERSION=17.6-1.pgdg13+1","PGDATA=/var/lib/postgresql/data"],
                 "Labels":{"com.docker.compose.project":"docker-services"}},
       "HostConfig":{"PortBindings":{"5432/tcp":[{"HostIp":"","HostPort":"5432"}]}},
       "Mounts":[{"Type":"volume","Name":"docker-services_postgres_data","Destination":"/var/lib/postgresql/data"}]},
      {"Id":"aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233","Name":"/querycraft-mariadb-1a2b",
       "State":{"Status":"exited","Running":false,"Health":{"Status":"unhealthy"}},
       "Config":{"Image":"docker.io/library/mariadb:11.4.13@sha256:abc","Env":["MARIADB_ROOT_PASSWORD=root-secret-2","MARIADB_USER=querycraft","MARIADB_PASSWORD=user-secret-3","MARIADB_DATABASE=querycraft_demo","MARIADB_VERSION=1:11.4.13+maria~ubu2404"],
                 "Labels":{"com.querycraft.managed":"true","com.querycraft.instance-id":"1a2b","com.querycraft.database":"querycraft_demo"}},
       "HostConfig":{"PortBindings":{"3306/tcp":[{"HostIp":"127.0.0.1","HostPort":"3307"}]}},
       "Mounts":[{"Type":"volume","Name":"querycraft-1a2b","Destination":"/var/lib/mysql"}]},
      {"Id":"ffeeddccbbaa","Name":"/legacy-mysql",
       "State":{"Status":"created"},
       "Config":{"Image":"registry.example.com:5000/team/mysql","Env":["MYSQL_RANDOM_ROOT_PASSWORD=yes"],"Labels":null},
       "HostConfig":{"PortBindings":{}}}
    ]"#;

    #[test]
    fn parses_docker_version_with_the_daemon_up() {
        let s = parse_version(VERSION_UP, "", Os::Windows);
        assert!(s.installed && s.daemon_running && s.problem.is_none());
        assert_eq!(s.client_version.as_deref(), Some("29.8.2"));
        assert_eq!(
            s.platform.as_deref(),
            Some("Docker Desktop 4.94.0 (241994)")
        );
    }

    #[test]
    fn tells_a_stopped_daemon_from_a_permission_problem() {
        let down = parse_version(VERSION_DOWN, DOWN_STDERR, Os::Windows);
        assert!(down.installed && !down.daemon_running);
        assert_eq!(down.problem, Some(DockerProblem::DaemonStopped));
        assert_eq!(down.client_version.as_deref(), Some("29.8.2"));
        assert!(down.detail.unwrap().contains("dockerDesktopLinuxEngine"));

        // Older CLIs print nothing on stdout when the daemon is unreachable
        let denied = parse_version("", LINUX_PERMISSION, Os::Linux);
        assert_eq!(denied.problem, Some(DockerProblem::PermissionDenied));
        assert_eq!(
            denied.install_url,
            "https://docs.docker.com/engine/install/"
        );
    }

    #[test]
    fn maps_docker_errors_to_codes() {
        let code = |stderr: &str| docker_error(stderr, "x").code();
        assert_eq!(code(DOWN_STDERR), ErrorCode::DockerStopped);
        assert_eq!(code(LINUX_PERMISSION), ErrorCode::DockerPermission);
        assert_eq!(
            code(
                "Error response from daemon: driver failed programming external connectivity: Bind for 127.0.0.1:5432 failed: port is already allocated"
            ),
            ErrorCode::PortInUse
        );
        assert_eq!(
            code("write /var/lib/docker/tmp/x: no space left on device"),
            ErrorCode::DiskFull
        );
        assert_eq!(
            code(
                "Error response from daemon: manifest for postgres:99.1 not found: manifest unknown"
            ),
            ErrorCode::ImagePullFailed
        );
        assert_eq!(
            code(
                "Error response from daemon: Get \"https://registry-1.docker.io/v2/\": dial tcp: lookup registry-1.docker.io: no such host"
            ),
            ErrorCode::ImagePullFailed
        );
        assert_eq!(
            code("Conflict. The container name \"/qc\" is already in use by container \"abc\""),
            ErrorCode::InvalidInput
        );
        assert_eq!(code("something else"), ErrorCode::ProvisionFailed);
    }

    #[test]
    fn identifies_engines_by_image_not_name() {
        let cases = [
            ("postgres", Some((Engine::Postgres, None))),
            (
                "postgres:17.2-alpine",
                Some((Engine::Postgres, Some("17.2-alpine"))),
            ),
            (
                "docker.io/library/postgres:16",
                Some((Engine::Postgres, Some("16"))),
            ),
            (
                "postgis/postgis:16-3.4",
                Some((Engine::Postgres, Some("16-3.4"))),
            ),
            (
                "registry.example.com:5000/team/mysql",
                Some((Engine::Mysql, None)),
            ),
            (
                "registry.example.com:5000/team/mysql:8.4",
                Some((Engine::Mysql, Some("8.4"))),
            ),
            (
                "container-registry.oracle.com/mysql/mysql-server:8.0",
                Some((Engine::Mysql, Some("8.0"))),
            ),
            (
                "mariadb:11.4.13@sha256:abc",
                Some((Engine::Mariadb, Some("11.4.13"))),
            ),
            ("MariaDB", Some((Engine::Mariadb, None))),
            ("redis:7-alpine", None),
            ("my-postgres-backup:1", None),
            ("postgres-exporter", None),
        ];
        for (image, expected) in cases {
            let got = engine_of_image(image);
            let expected = expected.map(|(e, t): (Engine, Option<&str>)| (e, t.map(str::to_owned)));
            assert_eq!(got, expected, "{image}");
        }
    }

    #[test]
    fn lists_database_containers_from_ps() {
        assert_eq!(candidate_ids(PS), ["8861d95a7116", "aa11bb22cc33"]);
        assert!(candidate_ids("not json\n").is_empty());
    }

    #[test]
    fn describes_containers_without_their_passwords() {
        let all = parse_inspect(INSPECT).unwrap();
        let found: Vec<_> = all.iter().filter_map(describe).collect();
        assert_eq!(found.len(), 3);

        let pg = &found[0];
        assert_eq!(
            (pg.engine, pg.version.as_deref(), pg.host_port),
            (Engine::Postgres, Some("17.6"), Some(5432))
        );
        assert_eq!(
            (pg.user.as_deref(), pg.database.as_deref()),
            (Some("app"), Some("app"))
        );
        assert!(pg.password_known && !pg.managed);

        let maria = &found[1];
        assert!(maria.managed);
        assert_eq!(maria.instance_id.as_deref(), Some("1a2b"));
        assert_eq!(
            (
                maria.version.as_deref(),
                maria.host_ip.as_deref(),
                maria.host_port
            ),
            (Some("11.4.13"), Some("127.0.0.1"), Some(3307))
        );
        assert_eq!(maria.user.as_deref(), Some("querycraft"));
        assert_eq!(maria.health.as_deref(), Some("unhealthy"));

        // A random root password can't be recovered: the UI asks for credentials
        let legacy = &found[2];
        assert_eq!(legacy.engine, Engine::Mysql);
        assert!(!legacy.password_known && legacy.host_port.is_none());

        let json = serde_json::to_string(&found).unwrap();
        for secret in ["pg-secret-1", "root-secret-2", "user-secret-3"] {
            assert!(!json.contains(secret));
        }
        assert_eq!(all[1].secrets().len(), 2);
    }

    #[test]
    fn only_labelled_resources_pass_the_guard() {
        let all = parse_inspect(INSPECT).unwrap();
        // Unlabelled (compose) container, even with the right engine
        assert_eq!(
            check_managed(all[0].config.labels.as_ref(), "1a2b", "container")
                .unwrap_err()
                .code(),
            ErrorCode::NotManaged
        );
        // No labels at all
        assert!(check_managed(all[2].config.labels.as_ref(), "1a2b", "container").is_err());
        // QueryCraft's, but another instance's
        assert!(check_managed(all[1].config.labels.as_ref(), "other", "container").is_err());
        check_managed(all[1].config.labels.as_ref(), "1a2b", "container").unwrap();
        // A volume someone labelled managed=false
        let labels: HashMap<String, String> = [
            (LABEL_MANAGED.to_owned(), "false".to_owned()),
            (LABEL_INSTANCE.to_owned(), "1a2b".to_owned()),
        ]
        .into();
        assert!(check_managed(Some(&labels), "1a2b", "volume").is_err());
    }

    #[test]
    fn creates_labelled_loopback_containers_without_secrets_in_args() {
        let spec = ContainerSpec {
            instance_id: "1a2b",
            engine: Engine::Mysql,
            image: "mysql:8.4.13",
            name: "querycraft-mysql-1a2b",
            volume: "querycraft-1a2b",
            port: 3310,
            database: "querycraft_demo",
            user: "querycraft",
            password: "user-pass-123",
            root_password: "root-pass-456",
        };
        let (args, env) = create_args(&spec);
        let joined = args.join(" ");
        assert!(joined.contains("--publish 127.0.0.1:3310:3306"));
        assert!(!joined.contains("0.0.0.0"));
        assert!(joined.contains(
            "--label com.querycraft.managed=true --label com.querycraft.instance-id=1a2b"
        ));
        assert!(joined.contains("--restart unless-stopped"));
        assert!(joined.contains("--volume querycraft-1a2b:/var/lib/mysql"));
        assert!(joined.contains("-e MYSQL_ROOT_PASSWORD -e MYSQL_USER"));
        assert!(joined.ends_with("mysql:8.4.13"));
        assert!(!joined.contains("user-pass-123") && !joined.contains("root-pass-456"));
        assert!(env.contains(&("MYSQL_PASSWORD".into(), "user-pass-123".into())));

        let volume = volume_args("1a2b", "querycraft_demo", "querycraft-1a2b").join(" ");
        assert_eq!(
            volume,
            "volume create --label com.querycraft.managed=true --label com.querycraft.instance-id=1a2b --label com.querycraft.database=querycraft_demo querycraft-1a2b"
        );
    }

    #[test]
    fn recovers_logins_from_env() {
        let env = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect()
        };
        let pg = login_from_env(Engine::Postgres, &env(&[("POSTGRES_PASSWORD", "x")]));
        assert_eq!(
            (
                pg.user.as_str(),
                pg.database.as_str(),
                pg.password.as_deref()
            ),
            ("postgres", "postgres", Some("x"))
        );
        let trust = login_from_env(
            Engine::Postgres,
            &env(&[("POSTGRES_HOST_AUTH_METHOD", "trust")]),
        );
        assert_eq!(trust.password.as_deref(), Some(""));
        let file = login_from_env(
            Engine::Postgres,
            &env(&[("POSTGRES_PASSWORD_FILE", "/run/secrets/pg")]),
        );
        assert!(file.password.is_none());
        let root = login_from_env(
            Engine::Mysql,
            &env(&[("MYSQL_ROOT_PASSWORD", "r"), ("MYSQL_DATABASE", "shop")]),
        );
        assert_eq!(
            (root.user.as_str(), root.database.as_str()),
            ("root", "shop")
        );
        let maria = login_from_env(
            Engine::Mariadb,
            &env(&[("MYSQL_USER", "u"), ("MYSQL_PASSWORD", "p")]),
        );
        assert_eq!(
            (maria.user.as_str(), maria.password.as_deref()),
            ("u", Some("p"))
        );
    }
}
