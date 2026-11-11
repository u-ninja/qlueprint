//! The native provider: installs a server with the OS package manager, after the user approved
//! the exact commands in the consent dialog.
//!
//! | OS      | Manager                       | Elevation            | Port        | Start/stop               |
//! | ------- | ----------------------------- | -------------------- | ----------- | ------------------------ |
//! | Windows | winget                        | the installer's UAC  | chosen      | manual (`net start`, admin) |
//! | macOS   | Homebrew (never installed by us) | none              | default     | `brew services`          |
//! | Linux   | apt, dnf, pacman, zypper      | pkexec (polkit)      | default     | `pkexec systemctl`       |
//!
//! Not done, and said so in the plan: MySQL on Windows (its MSI needs the interactive MySQL
//! Configurator), MySQL on Arch and openSUSE (not in their repositories), MariaDB 10.11 on
//! Windows (not in winget), Windows service control (needs an elevated helper), uninstalling.
//!
//! `recipe` is pure (OS, manager and paths are inputs), so every OS's commands are unit-tested
//! on any machine. Commands run as argument vectors; the admin SQL goes on the client's stdin, so
//! no password reaches a process list except where an installer only takes it as an argument
//! (EDB's `--superpassword`, MariaDB's MSI `PASSWORD=`), which the plan notes.

use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::process::{self, Cmd, MASK};
use super::types::{Engine, NativePlan, Os};
use crate::db::{CommandError, ErrorCode};

pub(crate) const INSTALL_TIMEOUT: Duration = Duration::from_secs(45 * 60);
pub(crate) const SERVICE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Manager {
    Winget,
    Brew,
    Apt,
    Dnf,
    Pacman,
    Zypper,
}

impl Manager {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Winget => "winget",
            Self::Brew => "brew",
            Self::Apt => "apt-get",
            Self::Dnf => "dnf",
            Self::Pacman => "pacman",
            Self::Zypper => "zypper",
        }
    }
}

/// One command: a program and its arguments. `secrets` are masked wherever it's shown.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Step {
    pub program: String,
    pub args: Vec<String>,
    pub secrets: Vec<String>,
}

impl Step {
    fn new(program: impl Into<String>, args: &[&str]) -> Self {
        Self {
            program: program.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            secrets: Vec::new(),
        }
    }

    /// What the consent dialog shows: the command line, passwords masked.
    pub(crate) fn display(&self) -> String {
        let line = process::display_command(Path::new(&self.program), &self.args);
        self.secrets
            .iter()
            .filter(|s| !s.is_empty())
            .fold(line, |line, secret| line.replace(secret.as_str(), MASK))
    }

    pub(crate) fn cmd(&self, timeout: Duration) -> Cmd {
        Cmd {
            program: PathBuf::from(&self.program),
            args: self.args.clone(),
            env: Vec::new(),
            stdin: None,
            timeout,
        }
    }
}

/// How the app database and user get created once the server runs.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Setup {
    /// sqlx over TCP with an admin login.
    Sqlx {
        user: String,
        password: String,
        database: String,
    },
    /// The server's own client as an admin (socket or peer auth), SQL on stdin.
    Client(Step),
}

/// Everything a native install of one engine on one OS does.
#[derive(Debug, Clone)]
pub(crate) struct Recipe {
    pub manager: Option<Manager>,
    pub install: Vec<Step>,
    /// Starts the service and enables it at boot (empty when the installer does it).
    pub start: Vec<Step>,
    pub setup: Option<Setup>,
    pub service: Option<String>,
    pub port: u16,
    pub version: String,
    pub data_dir: Option<String>,
    pub supported: bool,
    pub elevated: bool,
    pub needs_root_password: bool,
    pub notes: Vec<String>,
    pub uninstall: Option<String>,
    /// Manual steps, shown instead of `install` when `supported` is false.
    pub manual: Vec<String>,
}

pub(crate) struct Inputs<'a> {
    pub os: Os,
    pub manager: Option<Manager>,
    /// Homebrew's prefix (`/opt/homebrew`), where keg-only formulae keep their binaries.
    pub brew_prefix: &'a str,
    /// The OS user, who is Postgres' superuser on a Homebrew install.
    pub os_user: &'a str,
    pub has_pkexec: bool,
    pub engine: Engine,
    pub version: &'a str,
    pub port: u16,
    pub root_password: &'a str,
}

fn default_port(engine: Engine) -> u16 {
    if engine == Engine::Postgres {
        5432
    } else {
        3306
    }
}

fn unsupported(
    manager: Option<Manager>,
    port: u16,
    version: &str,
    notes: &[&str],
    manual: &[&str],
) -> Recipe {
    Recipe {
        manager,
        install: Vec::new(),
        start: Vec::new(),
        setup: None,
        service: None,
        port,
        version: version.to_owned(),
        data_dir: None,
        supported: false,
        elevated: false,
        needs_root_password: false,
        notes: notes.iter().map(|n| (*n).to_owned()).collect(),
        uninstall: None,
        manual: manual.iter().map(|m| (*m).to_owned()).collect(),
    }
}

/// Creates the login role unless it exists.
pub(crate) fn pg_role_sql(user: &str, password: &str) -> String {
    format!(
        "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{user}') THEN CREATE ROLE {user} LOGIN PASSWORD '{password}'; END IF; END $$;"
    )
}

/// The admin SQL that creates the app user and database. Idempotent. Names are validated
/// identifiers and the password has no quotes (types.rs), so plain literals are safe.
pub(crate) fn setup_sql(engine: Engine, database: &str, user: &str, password: &str) -> String {
    match engine {
        // psql's \gexec runs the CREATE DATABASE only when the SELECT returns it
        Engine::Postgres => format!(
            "{}\nSELECT 'CREATE DATABASE {database} OWNER {user}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '{database}')\\gexec\n",
            pg_role_sql(user, password)
        ),
        _ => {
            let mut sql = format!("CREATE DATABASE IF NOT EXISTS `{database}`;\n");
            // TCP from 127.0.0.1 can match 'localhost' or the address, depending on name resolution
            for host in ["localhost", "127.0.0.1", "::1"] {
                sql.push_str(&format!(
                    "CREATE USER IF NOT EXISTS '{user}'@'{host}' IDENTIFIED BY '{password}';\n"
                ));
                sql.push_str(&format!(
                    "GRANT ALL PRIVILEGES ON `{database}`.* TO '{user}'@'{host}';\n"
                ));
            }
            sql
        }
    }
}

fn winget_install(id: &str, version: Option<&str>, override_args: String, secret: &str) -> Step {
    let mut args = vec!["install", "--id", id, "--exact"];
    if let Some(version) = version {
        args.extend(["--version", version]);
    }
    args.extend([
        "--silent",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--override",
    ]);
    let mut step = Step::new("winget", &args);
    step.args.push(override_args);
    step.secrets.push(secret.to_owned());
    step
}

fn windows(i: &Inputs) -> Recipe {
    let manual_mysql = [
        "winget install --id Oracle.MySQL --exact",
        "Then open MySQL Configurator from the Start menu to set the root password and start the service.",
    ];
    if i.manager != Some(Manager::Winget) {
        return unsupported(
            None,
            i.port,
            i.version,
            &[
                "winget (App Installer) wasn’t found. Install App Installer from the Microsoft Store, or use Docker.",
            ],
            &[],
        );
    }
    let (step, service, data_dir, version, uninstall) = match (i.engine, i.version) {
        (Engine::Postgres, v @ ("17" | "16")) => {
            let service = format!("postgresql-x64-{v}");
            let id = format!("PostgreSQL.PostgreSQL.{v}");
            let override_args = format!(
                "--mode unattended --unattendedmodeui none --superpassword {} --serverport {} --servicename {service} --disable-components stackbuilder",
                i.root_password, i.port
            );
            (
                winget_install(&id, None, override_args, i.root_password),
                service,
                format!(r"C:\Program Files\PostgreSQL\{v}\data"),
                format!("{v} (the latest {v}.x in winget)"),
                format!("winget uninstall --id {id} --exact"),
            )
        }
        (Engine::Mariadb, "11.4") => {
            let override_args = format!(
                "/quiet /norestart SERVICENAME=MariaDB PORT={} PASSWORD={}",
                i.port, i.root_password
            );
            (
                winget_install(
                    "MariaDB.Server",
                    Some("11.4.3.0"),
                    override_args,
                    i.root_password,
                ),
                "MariaDB".to_owned(),
                r"C:\Program Files\MariaDB 11.4\data".to_owned(),
                "11.4.3 (winget)".to_owned(),
                "winget uninstall --id MariaDB.Server --exact".to_owned(),
            )
        }
        (Engine::Mariadb, _) => {
            return unsupported(
                Some(Manager::Winget),
                i.port,
                i.version,
                &["winget has no MariaDB 10.11. Pick 11.4, or use Docker."],
                &[],
            );
        }
        _ => {
            return unsupported(
                Some(Manager::Winget),
                i.port,
                i.version,
                &[
                    "MySQL’s Windows installer needs its interactive MySQL Configurator, so QueryCraft can’t set it up unattended. Docker is the reliable way; or install it yourself:",
                ],
                &manual_mysql,
            );
        }
    };
    let (admin, admin_db) = if i.engine == Engine::Postgres {
        ("postgres", "postgres")
    } else {
        ("root", "")
    };
    Recipe {
        manager: Some(Manager::Winget),
        install: vec![step],
        start: Vec::new(),
        setup: Some(Setup::Sqlx { user: admin.into(), password: i.root_password.into(), database: admin_db.into() }),
        service: Some(service),
        port: i.port,
        version,
        data_dir: Some(data_dir),
        supported: true,
        elevated: true,
        needs_root_password: true,
        notes: vec![
            "Windows asks for administrator approval while the installer runs.".into(),
            "The installer takes the admin password as an argument, so it is briefly visible to other programs on this machine.".into(),
            "The service starts automatically at boot. QueryCraft can’t start or stop Windows services; use Services or `net start` as an administrator.".into(),
        ],
        uninstall: Some(uninstall),
        manual: Vec::new(),
    }
}

fn macos(i: &Inputs) -> Recipe {
    let port = default_port(i.engine);
    let formula = match (i.engine, i.version) {
        (Engine::Postgres, v) => format!("postgresql@{v}"),
        (Engine::Mysql, v) => format!("mysql@{v}"),
        (Engine::Mariadb, v) => format!("mariadb@{v}"),
        (Engine::Sqlite | Engine::Mssql, _) => {
            unreachable!("SQLite and SQL Server aren't installed")
        }
    };
    if i.manager != Some(Manager::Brew) {
        return unsupported(
            None,
            port,
            i.version,
            &[
                "Homebrew wasn’t found. QueryCraft doesn’t install Homebrew itself: get it from https://brew.sh, then check again. Docker is the other way.",
            ],
            &[
                &format!("brew install {formula}"),
                &format!("brew services start {formula}"),
            ],
        );
    }
    let brew = format!("{}/bin/brew", i.brew_prefix);
    let bin = |name: &str| format!("{}/opt/{formula}/bin/{name}", i.brew_prefix);
    let setup = match i.engine {
        // initdb on Homebrew makes the OS user a superuser with trust auth on localhost
        Engine::Postgres => Setup::Sqlx {
            user: i.os_user.into(),
            password: String::new(),
            database: "postgres".into(),
        },
        // root has no password after a Homebrew install; MariaDB maps the OS user over the socket
        Engine::Mysql => Setup::Client(Step::new(bin("mysql"), &["--user=root"])),
        _ => Setup::Client(Step::new(bin("mariadb"), &[])),
    };
    let mut notes = vec![format!(
        "Homebrew servers listen on the default port {port}."
    )];
    if i.port != port {
        notes.push(format!(
            "Port {} is ignored: native installs keep the default.",
            i.port
        ));
    }
    Recipe {
        manager: Some(Manager::Brew),
        install: vec![Step::new(&brew, &["install", &formula])],
        start: vec![Step::new(&brew, &["services", "start", &formula])],
        setup: Some(setup),
        service: Some(formula.clone()),
        port,
        version: format!("{} (Homebrew {formula})", i.version),
        data_dir: Some(if i.engine == Engine::Postgres {
            format!("{}/var/{formula}", i.brew_prefix)
        } else {
            format!("{}/var/mysql", i.brew_prefix)
        }),
        supported: true,
        elevated: false,
        needs_root_password: false,
        notes,
        uninstall: Some(format!(
            "brew services stop {formula}; brew uninstall {formula}"
        )),
        manual: Vec::new(),
    }
}

fn linux(i: &Inputs) -> Recipe {
    let port = default_port(i.engine);
    let version = "the version your distribution ships".to_owned();
    let Some(manager) = i.manager else {
        return unsupported(
            None,
            port,
            &version,
            &[
                "No supported package manager (apt, dnf, pacman, zypper) was found. Install the server with your distribution’s tools, or use Docker.",
            ],
            &[],
        );
    };
    // (package, extra init step run as root or another user, service)
    type Init = Option<(Option<&'static str>, Vec<&'static str>)>;
    let (package, init, service): (&str, Init, &str) = match (manager, i.engine) {
        (Manager::Apt, Engine::Postgres) => ("postgresql", None, "postgresql"),
        (Manager::Apt, Engine::Mysql) => ("mysql-server", None, "mysql"),
        (Manager::Apt, _) => ("mariadb-server", None, "mariadb"),
        (Manager::Dnf, Engine::Postgres) => (
            "postgresql-server",
            Some((None, vec!["/usr/bin/postgresql-setup", "--initdb"])),
            "postgresql",
        ),
        (Manager::Dnf, Engine::Mysql) => ("mysql-server", None, "mysqld"),
        (Manager::Dnf, _) => ("mariadb-server", None, "mariadb"),
        (Manager::Pacman, Engine::Postgres) => (
            "postgresql",
            Some((
                Some("postgres"),
                vec!["/usr/bin/initdb", "-D", "/var/lib/postgres/data"],
            )),
            "postgresql",
        ),
        (Manager::Pacman, Engine::Mariadb) => (
            "mariadb",
            Some((
                None,
                vec![
                    "/usr/bin/mariadb-install-db",
                    "--user=mysql",
                    "--basedir=/usr",
                    "--datadir=/var/lib/mysql",
                ],
            )),
            "mariadb",
        ),
        (Manager::Zypper, Engine::Postgres) => ("postgresql-server", None, "postgresql"),
        (Manager::Zypper, Engine::Mariadb) => ("mariadb", None, "mariadb"),
        (Manager::Pacman | Manager::Zypper, _) => {
            return unsupported(
                Some(manager),
                port,
                &version,
                &[
                    "Your distribution doesn’t package MySQL (it ships MariaDB instead). Pick MariaDB, or use Docker.",
                ],
                &[],
            );
        }
        (Manager::Winget | Manager::Brew, _) => unreachable!("not a Linux manager"),
    };
    let tool = format!("/usr/bin/{}", manager.name());
    let install_args: Vec<&str> = match manager {
        Manager::Apt => vec!["install", "-y", package],
        Manager::Dnf => vec!["install", "-y", package],
        Manager::Pacman => vec!["-S", "--noconfirm", "--needed", package],
        _ => vec!["--non-interactive", "install", package],
    };
    let pkexec = |user: Option<&str>, args: &[&str]| {
        let mut all: Vec<&str> = Vec::new();
        if let Some(user) = user {
            all.extend(["--user", user]);
        }
        all.extend(args);
        Step::new("/usr/bin/pkexec", &all)
    };
    let manual: Vec<String> = {
        let mut lines = vec![format!(
            "sudo {} {}",
            manager.name(),
            install_args.join(" ")
        )];
        lines.push(format!("sudo systemctl enable --now {service}"));
        lines
    };
    if !i.has_pkexec {
        let mut r = unsupported(
            Some(manager),
            port,
            &version,
            &[
                "pkexec (polkit) wasn’t found, so QueryCraft can’t ask for administrator rights. Run these yourself, then use Connect existing:",
            ],
            &[],
        );
        r.manual = manual;
        return r;
    }
    let mut install_line = vec![tool.as_str()];
    install_line.extend(&install_args);
    let mut install = vec![pkexec(None, &install_line)];
    if let Some((user, args)) = &init {
        install.push(pkexec(*user, args));
    }
    let setup = match i.engine {
        Engine::Postgres => Setup::Client(pkexec(
            Some("postgres"),
            &["/usr/bin/psql", "-v", "ON_ERROR_STOP=1", "-d", "postgres"],
        )),
        // root signs in over the socket as the OS root user (unix_socket / auth_socket)
        Engine::Mysql => Setup::Client(pkexec(None, &["/usr/bin/mysql"])),
        _ => Setup::Client(pkexec(None, &["/usr/bin/mariadb"])),
    };
    let mut notes = vec![
        "Each command asks for your password through polkit (pkexec).".to_owned(),
        format!("Distribution packages listen on the default port {port}."),
    ];
    if i.port != port {
        notes.push(format!(
            "Port {} is ignored: native installs keep the default.",
            i.port
        ));
    }
    if manager == Manager::Dnf && i.engine == Engine::Postgres {
        notes.push("Fedora’s pg_hba.conf uses ident for TCP logins; if signing in fails, change it to scram-sha-256 and restart PostgreSQL.".into());
    }
    let data_dir = match (manager, i.engine) {
        (Manager::Apt, Engine::Postgres) => "/var/lib/postgresql",
        (Manager::Pacman, Engine::Postgres) => "/var/lib/postgres/data",
        (_, Engine::Postgres) => "/var/lib/pgsql/data",
        _ => "/var/lib/mysql",
    };
    let remove = match manager {
        Manager::Apt => "apt-get remove",
        Manager::Dnf => "dnf remove",
        Manager::Pacman => "pacman -R",
        _ => "zypper remove",
    };
    Recipe {
        manager: Some(manager),
        install,
        start: vec![pkexec(
            None,
            &["/usr/bin/systemctl", "enable", "--now", service],
        )],
        setup: Some(setup),
        service: Some(service.to_owned()),
        port,
        version,
        data_dir: Some(data_dir.to_owned()),
        supported: true,
        elevated: true,
        needs_root_password: false,
        notes,
        uninstall: Some(format!("sudo {remove} {package}")),
        manual: Vec::new(),
    }
}

pub(crate) fn recipe(i: &Inputs) -> Recipe {
    match i.os {
        Os::Windows => windows(i),
        Os::Macos => macos(i),
        Os::Linux => linux(i),
    }
}

/// The plan the consent dialog shows. The token is a hash of everything shown, so the approval
/// covers exactly these commands.
pub(crate) fn to_plan(r: &Recipe, engine: Engine, database: &str, user: &str) -> NativePlan {
    let commands: Vec<String> = if r.supported {
        r.install
            .iter()
            .chain(&r.start)
            .map(Step::display)
            .collect()
    } else {
        r.manual.clone()
    };
    let setup_sql = r
        .setup
        .as_ref()
        .map(|setup| {
            let sql = setup_sql(engine, database, user, MASK);
            match setup {
                Setup::Client(step) => format!("{} <<SQL\n{sql}SQL", step.display()),
                Setup::Sqlx {
                    user: admin,
                    database: admin_db,
                    ..
                } => {
                    let db = if admin_db.is_empty() {
                        String::new()
                    } else {
                        format!("/{admin_db}")
                    };
                    format!("As {admin}@127.0.0.1:{}{db}:\n{sql}", r.port)
                }
            }
        })
        .unwrap_or_default();
    let mut hasher = Sha256::new();
    for line in commands.iter().chain([&setup_sql]) {
        hasher.update(line.as_bytes());
        hasher.update(b"\n");
    }
    hasher.update(format!("{engine:?}:{}:{database}:{user}", r.port).as_bytes());
    NativePlan {
        manager: r.manager.map(|m| m.name().to_owned()),
        commands,
        setup_sql,
        elevated: r.elevated,
        supported: r.supported,
        needs_root_password: r.needs_root_password,
        service: r.service.clone(),
        notes: r.notes.clone(),
        consent_token: hex::encode(hasher.finalize()),
        uninstall: r.uninstall.clone(),
    }
}

/// The package manager on this machine, and Homebrew's prefix on macOS.
pub(crate) fn detect(os: Os) -> (Option<Manager>, String, bool) {
    match os {
        Os::Windows => {
            let mut extra = Vec::new();
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                extra.push(PathBuf::from(local).join(r"Microsoft\WindowsApps"));
            }
            let winget = process::find_program("winget", &extra).map(|_| Manager::Winget);
            (winget, String::new(), false)
        }
        Os::Macos => {
            let brew = process::find_program(
                "brew",
                &["/opt/homebrew/bin".into(), "/usr/local/bin".into()],
            );
            let prefix = brew
                .as_deref()
                .and_then(Path::parent)
                .and_then(Path::parent)
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            (brew.map(|_| Manager::Brew), prefix, false)
        }
        Os::Linux => {
            let manager = [
                (Manager::Apt, "apt-get"),
                (Manager::Dnf, "dnf"),
                (Manager::Pacman, "pacman"),
                (Manager::Zypper, "zypper"),
            ]
            .into_iter()
            .find(|(_, name)| Path::new("/usr/bin").join(name).exists())
            .map(|(m, _)| m);
            (
                manager,
                String::new(),
                Path::new("/usr/bin/pkexec").exists(),
            )
        }
    }
}

pub(crate) fn os_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default()
}

/// Resolves a step's program: absolute paths as they are, bare names (winget) on PATH.
fn resolve(step: &Step) -> Result<PathBuf, CommandError> {
    let path = PathBuf::from(&step.program);
    if path.is_absolute() {
        return Ok(path);
    }
    let mut extra = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        extra.push(PathBuf::from(local).join(r"Microsoft\WindowsApps"));
    }
    process::find_program(&step.program, &extra).ok_or_else(|| {
        CommandError::new(
            ErrorCode::NativeUnsupported,
            format!("{} wasn’t found on this machine.", step.program),
        )
    })
}

/// Runs one step, streaming its masked output. `stdin` goes to the program's input.
pub(crate) async fn run_step(
    step: &Step,
    stdin: Option<String>,
    timeout: Duration,
    on_line: &(dyn Fn(&str) + Sync),
) -> Result<(), CommandError> {
    let mut cmd = step.cmd(timeout);
    cmd.program = resolve(step)?;
    cmd.stdin = stdin;
    let secrets: Vec<&str> = step.secrets.iter().map(String::as_str).collect();
    let mut tail: Vec<String> = Vec::new();
    let out = process::run(&cmd, None, |line| {
        let line = process::mask(line, &secrets);
        on_line(&line);
        tail.push(line);
        if tail.len() > 8 {
            tail.remove(0);
        }
    })
    .await
    .map_err(|e| match e {
        process::RunError::TimedOut => CommandError::new(
            ErrorCode::StartupTimeout,
            format!("{} took too long.", step.display()),
        ),
        process::RunError::NotFound => CommandError::new(
            ErrorCode::NativeUnsupported,
            format!("{} wasn’t found.", step.program),
        ),
        other => CommandError::new(
            ErrorCode::ProvisionFailed,
            format!("{} failed: {other:?}", step.display()),
        ),
    })?;
    if out.success {
        return Ok(());
    }
    Err(step_error(step, out.code, &tail.join("\n")))
}

/// Maps a failed step to an error code and what to do next.
pub(crate) fn step_error(step: &Step, code: Option<i32>, output: &str) -> CommandError {
    let lower = output.to_ascii_lowercase();
    // pkexec: 126 = the dialog was dismissed, 127 = not authorized
    let declined = step.program.ends_with("pkexec") && matches!(code, Some(126 | 127));
    // winget's "installer cancelled by user" / UAC declined (0x800704c7)
    let uac = lower.contains("0x800704c7")
        || lower.contains("cancelled by the user")
        || lower.contains("canceled by the user");
    if declined || uac {
        return CommandError::new(
            ErrorCode::PermissionDenied,
            "Administrator approval was declined, so nothing was installed.",
        );
    }
    if lower.contains("already installed") || lower.contains("0x8a150061") {
        return CommandError::new(
            ErrorCode::InvalidInput,
            "It’s already installed. Use Connect existing to add a connection to it instead.",
        );
    }
    if lower.contains("no space left")
        || lower.contains("not enough space")
        || lower.contains("0x80070070")
    {
        return CommandError::new(
            ErrorCode::DiskFull,
            "The disk is full. Free some space and try again.",
        );
    }
    CommandError::new(
        ErrorCode::ProvisionFailed,
        format!(
            "{} failed (exit code {}):\n{}",
            step.display(),
            code.map_or("?".into(), |c| c.to_string()),
            output.trim()
        ),
    )
}

/// The command that starts, stops or restarts a native service, or why QueryCraft can't.
pub(crate) fn service_step(
    os: Os,
    brew_prefix: &str,
    service: &str,
    verb: &str,
) -> Result<Step, CommandError> {
    match os {
        Os::Macos => Ok(Step::new(
            format!("{brew_prefix}/bin/brew"),
            &["services", verb, service],
        )),
        Os::Linux => Ok(Step::new(
            "/usr/bin/pkexec",
            &["/usr/bin/systemctl", verb, service],
        )),
        Os::Windows => {
            let manual = match verb {
                "restart" => format!("net stop {service} && net start {service}"),
                _ => format!("net {verb} {service}"),
            };
            Err(CommandError::new(
                ErrorCode::NativeUnsupported,
                format!(
                    "QueryCraft can’t control Windows services. In a terminal run as administrator: {manual}"
                ),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(
        os: Os,
        manager: Option<Manager>,
        engine: Engine,
        version: &'static str,
    ) -> Inputs<'static> {
        Inputs {
            os,
            manager,
            brew_prefix: "/opt/homebrew",
            os_user: "ana",
            has_pkexec: true,
            engine,
            version,
            port: 5433,
            root_password: "Root-pass-456",
        }
    }

    fn commands(r: &Recipe) -> Vec<String> {
        to_plan(r, Engine::Postgres, "querycraft_demo", "querycraft").commands
    }

    #[test]
    fn windows_postgres_uses_winget_with_masked_superpassword() {
        let r = recipe(&inputs(
            Os::Windows,
            Some(Manager::Winget),
            Engine::Postgres,
            "17",
        ));
        assert!(r.supported && r.elevated && r.needs_root_password);
        assert_eq!(r.port, 5433);
        let shown = commands(&r);
        assert_eq!(
            shown,
            [
                r#"winget install --id PostgreSQL.PostgreSQL.17 --exact --silent --accept-source-agreements --accept-package-agreements --override "--mode unattended --unattendedmodeui none --superpassword ******** --serverport 5433 --servicename postgresql-x64-17 --disable-components stackbuilder""#
            ]
        );
        // The real argument has the password; only the display masks it
        assert!(r.install[0].args.last().unwrap().contains("Root-pass-456"));
        assert_eq!(r.service.as_deref(), Some("postgresql-x64-17"));
        assert!(matches!(&r.setup, Some(Setup::Sqlx { user, .. }) if user == "postgres"));
    }

    #[test]
    fn windows_mariadb_pins_the_winget_version_and_mysql_is_manual() {
        let r = recipe(&inputs(
            Os::Windows,
            Some(Manager::Winget),
            Engine::Mariadb,
            "11.4",
        ));
        assert!(r.supported);
        assert!(
            commands(&r)[0]
                .starts_with("winget install --id MariaDB.Server --exact --version 11.4.3.0")
        );
        assert!(commands(&r)[0].contains("PASSWORD=********"));
        assert!(
            !recipe(&inputs(
                Os::Windows,
                Some(Manager::Winget),
                Engine::Mariadb,
                "10.11"
            ))
            .supported
        );

        let mysql = recipe(&inputs(
            Os::Windows,
            Some(Manager::Winget),
            Engine::Mysql,
            "8.4",
        ));
        assert!(!mysql.supported && mysql.install.is_empty());
        assert_eq!(
            commands(&mysql)[0],
            "winget install --id Oracle.MySQL --exact"
        );
        assert!(!recipe(&inputs(Os::Windows, None, Engine::Postgres, "17")).supported);
    }

    #[test]
    fn macos_uses_homebrew_formulae_and_services() {
        let r = recipe(&inputs(
            Os::Macos,
            Some(Manager::Brew),
            Engine::Postgres,
            "17",
        ));
        assert!(r.supported && !r.elevated && !r.needs_root_password);
        assert_eq!(r.port, 5432);
        assert_eq!(
            commands(&r),
            [
                "brew install postgresql@17",
                "brew services start postgresql@17"
            ]
        );
        assert_eq!(r.install[0].program, "/opt/homebrew/bin/brew");
        assert!(matches!(&r.setup, Some(Setup::Sqlx { user, .. }) if user == "ana"));
        assert!(r.notes.iter().any(|n| n.contains("5433 is ignored")));

        let maria = recipe(&inputs(
            Os::Macos,
            Some(Manager::Brew),
            Engine::Mariadb,
            "10.11",
        ));
        assert_eq!(commands(&maria)[0], "brew install mariadb@10.11");
        assert!(
            matches!(&maria.setup, Some(Setup::Client(step)) if step.program == "/opt/homebrew/opt/mariadb@10.11/bin/mariadb")
        );

        // Never installs Homebrew: without it, only manual steps and a link
        let none = recipe(&inputs(Os::Macos, None, Engine::Mysql, "8.4"));
        assert!(!none.supported && none.notes[0].contains("https://brew.sh"));
        assert_eq!(
            commands(&none),
            ["brew install mysql@8.4", "brew services start mysql@8.4"]
        );
    }

    #[test]
    fn linux_runs_each_manager_through_pkexec() {
        let apt = recipe(&inputs(
            Os::Linux,
            Some(Manager::Apt),
            Engine::Postgres,
            "17",
        ));
        assert_eq!(
            commands(&apt),
            [
                "pkexec /usr/bin/apt-get install -y postgresql",
                "pkexec /usr/bin/systemctl enable --now postgresql"
            ]
        );
        assert!(
            matches!(&apt.setup, Some(Setup::Client(step)) if step.display() == "pkexec --user postgres /usr/bin/psql -v ON_ERROR_STOP=1 -d postgres")
        );

        let dnf = recipe(&inputs(
            Os::Linux,
            Some(Manager::Dnf),
            Engine::Postgres,
            "17",
        ));
        assert_eq!(
            commands(&dnf),
            [
                "pkexec /usr/bin/dnf install -y postgresql-server",
                "pkexec /usr/bin/postgresql-setup --initdb",
                "pkexec /usr/bin/systemctl enable --now postgresql"
            ]
        );
        let pacman = recipe(&inputs(
            Os::Linux,
            Some(Manager::Pacman),
            Engine::Mariadb,
            "11.4",
        ));
        assert_eq!(
            commands(&pacman)[0],
            "pkexec /usr/bin/pacman -S --noconfirm --needed mariadb"
        );
        assert_eq!(
            commands(&pacman)[1],
            "pkexec /usr/bin/mariadb-install-db --user=mysql --basedir=/usr --datadir=/var/lib/mysql"
        );
        let zypper = recipe(&inputs(
            Os::Linux,
            Some(Manager::Zypper),
            Engine::Mariadb,
            "11.4",
        ));
        assert_eq!(
            commands(&zypper)[0],
            "pkexec /usr/bin/zypper --non-interactive install mariadb"
        );
        let dnf_mysql = recipe(&inputs(Os::Linux, Some(Manager::Dnf), Engine::Mysql, "8.4"));
        assert_eq!(dnf_mysql.service.as_deref(), Some("mysqld"));

        assert!(
            !recipe(&inputs(
                Os::Linux,
                Some(Manager::Pacman),
                Engine::Mysql,
                "8.4"
            ))
            .supported
        );
        let mut no_pkexec = inputs(Os::Linux, Some(Manager::Apt), Engine::Mysql, "8.4");
        no_pkexec.has_pkexec = false;
        let manual = recipe(&no_pkexec);
        assert!(!manual.supported);
        assert_eq!(
            commands(&manual),
            [
                "sudo apt-get install -y mysql-server",
                "sudo systemctl enable --now mysql"
            ]
        );
        assert!(!recipe(&inputs(Os::Linux, None, Engine::Postgres, "17")).supported);
    }

    #[test]
    fn setup_sql_is_idempotent_and_masked_in_the_plan() {
        let pg = setup_sql(Engine::Postgres, "shop", "app", "pw-12345678");
        assert!(pg.contains("IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app')"));
        assert!(pg.contains("\\gexec"));
        let my = setup_sql(Engine::Mysql, "shop", "app", "pw-12345678");
        assert_eq!(my.matches("CREATE USER IF NOT EXISTS").count(), 3);

        let r = recipe(&inputs(Os::Linux, Some(Manager::Apt), Engine::Mysql, "8.4"));
        let plan = to_plan(&r, Engine::Mysql, "querycraft_demo", "querycraft");
        assert!(plan.setup_sql.contains("IDENTIFIED BY '********'"));
        assert!(!plan.setup_sql.contains("Root-pass-456"));
    }

    #[test]
    fn the_consent_token_changes_with_the_commands() {
        let a = recipe(&inputs(
            Os::Windows,
            Some(Manager::Winget),
            Engine::Postgres,
            "17",
        ));
        let b = recipe(&inputs(
            Os::Windows,
            Some(Manager::Winget),
            Engine::Postgres,
            "16",
        ));
        let token = |r: &Recipe| {
            to_plan(r, Engine::Postgres, "querycraft_demo", "querycraft").consent_token
        };
        assert_eq!(token(&a), token(&a.clone()));
        assert_ne!(token(&a), token(&b));
    }

    #[test]
    fn maps_failed_steps_to_codes() {
        let pk = Step::new("/usr/bin/pkexec", &["/usr/bin/apt-get"]);
        assert_eq!(
            step_error(&pk, Some(126), "").code(),
            ErrorCode::PermissionDenied
        );
        let winget = Step::new("winget", &["install"]);
        assert_eq!(
            step_error(
                &winget,
                Some(1),
                "Installer failed with exit code: 0x800704c7"
            )
            .code(),
            ErrorCode::PermissionDenied
        );
        assert_eq!(
            step_error(
                &winget,
                Some(1),
                "Found an existing package already installed."
            )
            .code(),
            ErrorCode::InvalidInput
        );
        assert_eq!(
            step_error(&winget, Some(2), "boom").code(),
            ErrorCode::ProvisionFailed
        );
        assert!(
            service_step(Os::Windows, "", "MariaDB", "start")
                .unwrap_err()
                .message()
                .contains("net start MariaDB")
        );
        assert_eq!(
            service_step(Os::Linux, "", "mariadb", "stop")
                .unwrap()
                .display(),
            "pkexec /usr/bin/systemctl stop mariadb"
        );
        assert_eq!(
            service_step(Os::Macos, "/opt/homebrew", "mysql@8.4", "restart")
                .unwrap()
                .display(),
            "brew services restart mysql@8.4"
        );
    }
}
