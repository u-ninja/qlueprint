//! Local databases: create, discover and manage database servers on this machine.
//!
//! Providers: Docker (recommended for servers on every OS), a native install through the OS
//! package manager (only after the user approved the exact commands), and SQLite files.
//! The UI only reaches this through the narrow commands below; every input is validated here.
//!
//! Instances are tracked in `local_instances.json` (store.rs); their connections go through the
//! regular saved-connection system (saved.rs), so passwords end up in the OS credential store
//! and nowhere else. Every lifecycle action is written to the audit log.

mod docker;
mod native;
mod ports;
pub(crate) mod process;
mod sample;
mod store;
mod types;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, State};
use tauri_specta::Event;

pub use docker::{DiscoveredContainer, DockerStatus};
pub use types::*;

use crate::audit::{Audit, Details, EventKind};
use crate::db::{
    self, CommandError, ConnectRequest, Connections, ErrorCode, Pool, Server, ServerLogin, invalid,
};
use crate::saved::{self, Saved, SavedConnection};
use docker::{ContainerSpec, Docker, Inspect};
use process::Cancel;
use store::Store;

/// Ports the native discovery checks: each engine's default and the next two.
const NATIVE_PORTS: [u16; 6] = [5432, 5433, 5434, 3306, 3307, 3308];
/// The address every local server is reached on; containers publish to it only.
const HOST: &str = "127.0.0.1";
const MAX_LOG_LINES: u32 = 2000;

/// State for the local database commands.
pub struct Local {
    /// The app data directory; SQLite databases go in `databases/` under it.
    dir: PathBuf,
    store: Store,
    /// Provisionings in flight, by provisioning id, so `cancel_provisioning` can reach them.
    running: Mutex<HashMap<String, Arc<Cancel>>>,
}

impl Local {
    pub fn load(dir: PathBuf) -> Self {
        Self {
            store: Store::load(&dir),
            dir,
            running: Mutex::default(),
        }
    }

    fn sqlite_dir(&self) -> PathBuf {
        self.dir.join("databases")
    }

    fn running(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Cancel>>> {
        self.running.lock().expect("provisioning lock poisoned")
    }
}

/// The app state a provisioning or lifecycle action touches; Tauri-free so tests can build it.
pub(crate) struct Deps<'a> {
    pub local: &'a Local,
    pub saved: &'a Saved,
    pub connections: &'a Connections,
    pub audit: &'a Audit,
}

fn now_ms() -> i64 {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    ms.try_into().unwrap_or(i64::MAX)
}

// --- Discovery -------------------------------------------------------------------------------

/// A server listening on this machine that isn't one of the Docker containers.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredNative {
    pub engine: Engine,
    pub port: u16,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub docker: DockerStatus,
    pub containers: Vec<DiscoveredContainer>,
    pub native: Vec<DiscoveredNative>,
    /// Docker runs but listing its containers failed.
    pub containers_error: Option<String>,
}

/// Probes the usual ports, skipping those a container publishes (Docker Desktop forwards them).
async fn discover_native(container_ports: &[u16]) -> Vec<DiscoveredNative> {
    let ports: Vec<u16> = NATIVE_PORTS
        .into_iter()
        .filter(|p| !container_ports.contains(p))
        .collect();
    let probes = futures_util::future::join_all(ports.iter().map(|&p| ports::probe(p))).await;
    ports
        .into_iter()
        .zip(probes)
        .filter_map(|(port, probe)| {
            let probe = probe?;
            Some(DiscoveredNative {
                engine: probe.engine,
                port,
                version: probe.version,
            })
        })
        .collect()
}

#[tauri::command]
#[specta::specta]
pub async fn docker_status() -> DockerStatus {
    Docker::status().await
}

/// Docker status, database containers (by image, managed or not) and native servers.
#[tauri::command]
#[specta::specta]
pub async fn discover_local_databases() -> Discovery {
    let status = Docker::status().await;
    let (containers, containers_error) = match Docker::locate() {
        Some(docker) if status.daemon_running => match docker.database_containers().await {
            Ok(all) => (all.iter().filter_map(docker::describe).collect(), None),
            Err(e) => (Vec::new(), Some(e.message().to_owned())),
        },
        _ => (Vec::new(), None),
    };
    let published: Vec<u16> = containers
        .iter()
        .filter_map(|c: &DiscoveredContainer| c.host_port)
        .collect();
    Discovery {
        native: discover_native(&published).await,
        docker: status,
        containers,
        containers_error,
    }
}

#[tauri::command]
#[specta::specta]
pub fn local_database_templates() -> Vec<Template> {
    templates()
}

// --- Planning --------------------------------------------------------------------------------

/// Names QueryCraft gives a container and its volume when the user leaves them empty.
fn container_name(request: &LocalRequest) -> String {
    if request.container_name.is_empty() {
        format!(
            "querycraft-{}-{}",
            engine_slug(request.engine),
            request.port
        )
    } else {
        request.container_name.clone()
    }
}

fn engine_slug(engine: Engine) -> &'static str {
    match engine {
        Engine::Postgres => "postgres",
        Engine::Mysql => "mysql",
        Engine::Mariadb => "mariadb",
        Engine::Mssql => "mssql",
        Engine::Sqlite => "sqlite",
    }
}

fn volume_name(container: &str) -> String {
    format!("{container}-data")
}

fn sqlite_path(local: &Local, database: &str) -> PathBuf {
    local.sqlite_dir().join(format!("{database}.db"))
}

fn image(engine: Engine, tag: &str) -> String {
    format!(
        "{}:{tag}",
        image_repository(engine).expect("server engines have an image")
    )
}

fn port_blocker(port: u16) -> String {
    let next = ports::next_free(port, ports::port_free);
    match next {
        Some(next) => format!("Port {port} is in use. {next} is free."),
        None => format!("Port {port} is in use. Pick another port."),
    }
}

fn daemon_blocker(status: &DockerStatus) -> Option<String> {
    match status.problem? {
        docker::DockerProblem::NotInstalled => Some("Docker isn’t installed.".into()),
        docker::DockerProblem::DaemonStopped => {
            Some("Docker isn’t running. Start Docker Desktop (or the docker service).".into())
        }
        docker::DockerProblem::PermissionDenied => {
            Some("Docker refused this user. On Linux, add yourself to the docker group.".into())
        }
    }
}

/// Validates the request and describes what creating it would do, without changing anything.
pub(crate) async fn plan(local: &Local, request: &LocalRequest) -> Result<LocalPlan, CommandError> {
    request.validate()?;
    let mut plan = LocalPlan {
        engine: request.engine,
        provider: request.provider,
        version: String::new(),
        image: None,
        host: HOST.into(),
        port: None,
        port_free: true,
        suggested_port: None,
        database: request.database.clone(),
        user: None,
        container_name: None,
        storage: String::new(),
        sample_data: request.sample_data,
        native: None,
        warnings: Vec::new(),
        blockers: Vec::new(),
    };
    match request.provider {
        Provider::File => {
            let path = sqlite_path(local, &request.database);
            if path.exists() {
                plan.blockers.push(format!(
                    "{} already exists. Pick another name.",
                    path.display()
                ));
            }
            plan.host = String::new();
            plan.version = "bundled".into();
            plan.storage = path.display().to_string();
        }
        Provider::Docker => {
            let version = pinned_version(request.engine, &request.version)?;
            let name = container_name(request);
            plan.version = version.tag.into();
            plan.image = Some(image(request.engine, version.tag));
            plan.port = Some(request.port);
            plan.user = Some(request.user.clone());
            plan.storage = volume_name(&name);
            plan.port_free = ports::port_free(request.port);
            if !plan.port_free {
                plan.suggested_port = ports::next_free(request.port, ports::port_free);
                plan.blockers.push(port_blocker(request.port));
            }
            let status = Docker::status().await;
            if let Some(blocker) = daemon_blocker(&status) {
                plan.blockers.push(blocker);
            } else if let Some(docker) = Docker::locate() {
                if docker.inspect(&name).await?.is_some() {
                    plan.blockers.push(format!(
                        "A container named {name} already exists. Pick another container name."
                    ));
                }
                if docker.volume_labels(&plan.storage).await?.is_some() {
                    plan.blockers.push(format!(
                        "A volume named {} already exists. Pick another container name.",
                        plan.storage
                    ));
                }
                if !docker
                    .image_present(plan.image.as_deref().unwrap_or_default())
                    .await
                {
                    plan.warnings.push(
                        "The image isn’t downloaded yet; Docker pulls it first (a few hundred MB)."
                            .into(),
                    );
                }
            }
            plan.container_name = Some(name);
        }
        Provider::Native => {
            let recipe = native_recipe(request);
            if recipe.needs_root_password {
                types::check_password(&request.root_password, "Admin password")?;
            }
            plan.version = recipe.version.clone();
            plan.port = Some(recipe.port);
            plan.user = Some(request.user.clone());
            plan.storage = recipe.data_dir.clone().unwrap_or_default();
            if recipe.supported {
                if ports::probe(recipe.port).await.is_some() {
                    plan.port_free = false;
                    plan.blockers.push(format!(
                        "A database server already listens on port {}. Use Connect existing for it instead.",
                        recipe.port
                    ));
                } else if !ports::port_free(recipe.port) {
                    plan.port_free = false;
                    plan.blockers.push(port_blocker(recipe.port));
                }
            } else {
                plan.blockers.extend(recipe.notes.first().cloned());
            }
            plan.native = Some(native::to_plan(
                &recipe,
                request.engine,
                &request.database,
                &request.user,
            ));
        }
    }
    Ok(plan)
}

/// The native recipe for this machine's OS and package manager.
fn native_recipe(request: &LocalRequest) -> native::Recipe {
    let os = Os::current();
    let (manager, brew_prefix, has_pkexec) = native::detect(os);
    native::recipe(&native::Inputs {
        os,
        manager,
        brew_prefix: &brew_prefix,
        os_user: &native::os_user(),
        has_pkexec,
        engine: request.engine,
        version: &request.version,
        port: request.port,
        root_password: &request.root_password,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn plan_local_database(
    request: LocalRequest,
    local: State<'_, Local>,
) -> Result<LocalPlan, CommandError> {
    plan(&local, &request).await
}

// --- Provisioning ----------------------------------------------------------------------------

/// Sends progress events and remembers the current stage, so a failure is reported on it.
pub(crate) struct Progress<'a> {
    id: String,
    emit: &'a (dyn Fn(LocalProgress) + Send + Sync),
    current: Mutex<Stage>,
    cancellable: AtomicBool,
}

impl<'a> Progress<'a> {
    pub(crate) fn new(id: String, emit: &'a (dyn Fn(LocalProgress) + Send + Sync)) -> Self {
        Self {
            id,
            emit,
            current: Mutex::new(Stage::CheckingRuntime),
            cancellable: AtomicBool::new(true),
        }
    }

    fn stage(&self) -> Stage {
        *self.current.lock().expect("progress lock poisoned")
    }

    fn send(&self, stage: Stage, state: StageState, message: Option<String>) {
        (self.emit)(LocalProgress {
            provisioning_id: self.id.clone(),
            stage,
            state,
            message,
            cancellable: self.cancellable.load(Ordering::SeqCst),
        });
    }

    fn start(&self, stage: Stage) {
        *self.current.lock().expect("progress lock poisoned") = stage;
        self.send(stage, StageState::Running, None);
    }

    fn done(&self, message: impl Into<Option<String>>) {
        self.send(self.stage(), StageState::Done, message.into());
    }

    fn skip(&self, stage: Stage, message: &str) {
        *self.current.lock().expect("progress lock poisoned") = stage;
        self.send(stage, StageState::Skipped, Some(message.into()));
    }

    fn output(&self, line: &str) {
        if !line.trim().is_empty() {
            self.send(self.stage(), StageState::Output, Some(line.to_owned()));
        }
    }

    fn fail(&self, message: &str) {
        self.send(self.stage(), StageState::Failed, Some(message.to_owned()));
    }

    /// From here on, cancelling would leave a half-registered database, so it's refused.
    fn no_cancel(&self) {
        self.cancellable.store(false, Ordering::SeqCst);
    }
}

fn check_cancel(cancel: &Cancel) -> Result<(), CommandError> {
    if cancel.is_cancelled() {
        Err(CommandError::new(ErrorCode::Cancelled, "Cancelled."))
    } else {
        Ok(())
    }
}

fn server_request(
    engine: Engine,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
) -> ConnectRequest {
    let login = ServerLogin {
        server: Server {
            host: HOST.into(),
            port,
            user: user.into(),
            database: database.into(),
            ..Default::default()
        },
        password: password.into(),
    };
    match engine {
        Engine::Postgres => ConnectRequest::Postgres(login),
        _ => ConnectRequest::Mysql(login),
    }
}

/// Opens a pool, retrying while a just-started server finishes coming up.
async fn open_with_retry(
    request: &(dyn Fn() -> ConnectRequest + Sync),
    attempts: u32,
) -> Result<db::Open, CommandError> {
    let mut last = None;
    for attempt in 0..attempts {
        match db::open(request()).await {
            Ok(open) => return Ok(open),
            // Wrong credentials won't fix themselves
            Err(e) if e.code() == ErrorCode::InvalidCredentials => return Err(e),
            Err(e) => last = Some(e),
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    Err(last.expect("at least one attempt"))
}

async fn ping(pool: &Pool) -> Result<(), CommandError> {
    let result = match pool {
        Pool::Postgres(p) => sqlx::query("SELECT 1").execute(p).await.map(drop),
        Pool::Mysql(p) => sqlx::query("SELECT 1").execute(p).await.map(drop),
        Pool::Sqlite(p) => sqlx::query("SELECT 1").execute(p).await.map(drop),
        Pool::Mssql(p) => return crate::mssql::catalog(p, "SELECT 1", &[]).await.map(drop),
    };
    result.map_err(db::connect_failed)
}

fn connection_label(instance: &LocalInstance) -> String {
    match instance.port {
        Some(port) => format!(
            "{} · {} :{port}",
            instance.database,
            engine_name(instance.engine)
        ),
        None => format!("{}.db", instance.database),
    }
}

fn audit_details(instance: &LocalInstance) -> Details {
    let target = match instance.provider {
        Provider::Docker => format!(
            "docker {} {HOST}:{}",
            instance.container_name.as_deref().unwrap_or_default(),
            instance.port.unwrap_or_default()
        ),
        Provider::Native => format!(
            "native {} {HOST}:{}",
            instance.service.as_deref().unwrap_or_default(),
            instance.port.unwrap_or_default()
        ),
        Provider::File => instance.data_path.clone().unwrap_or_default(),
    };
    Details {
        label: Some(instance.name.clone()),
        engine: Some(instance.engine),
        target: Some(target),
        database: Some(instance.database.clone()),
        ..Default::default()
    }
}

async fn record(
    deps: &Deps<'_>,
    kind: EventKind,
    instance: &LocalInstance,
    error: Option<&CommandError>,
) {
    let mut details = audit_details(instance);
    if let Some(error) = error {
        details = details.with_error(error);
    }
    deps.audit
        .record(kind, instance.saved_connection_id.as_deref(), details)
        .await;
}

/// The shared end of every provider: sample data, validation, the saved connection, Ready.
/// A sample data failure keeps going: the database works, and the UI offers a retry.
async fn finish(
    deps: &Deps<'_>,
    p: &Progress<'_>,
    mut instance: LocalInstance,
    request: &(dyn Fn() -> ConnectRequest + Sync),
    sample_data: bool,
) -> Result<LocalCreated, CommandError> {
    p.no_cancel();
    let open = open_with_retry(request, 15).await?;
    let mut sample_error = None;
    if sample_data {
        p.start(Stage::InitializingSampleData);
        match sample::load(&open.pool).await {
            Ok(()) => {
                instance.sample_data = SampleState::Loaded;
                p.done(None);
            }
            Err(error) => {
                instance.sample_data = SampleState::Failed;
                p.fail(error.message());
                sample_error = Some(error);
            }
        }
    } else {
        p.skip(Stage::InitializingSampleData, "Turned off");
    }

    p.start(Stage::Validating);
    let checked = ping(&open.pool).await;
    let starter = (instance.sample_data == SampleState::Loaded)
        .then(|| sample::starter_sql(&open.pool).to_owned());
    open.close().await;
    checked?;
    p.done(Some(format!(
        "Signed in as {}",
        instance.user.as_deref().unwrap_or("the file owner")
    )));

    p.start(Stage::RegisteringConnection);
    let label = connection_label(&instance);
    let saved =
        saved::save_connection(request(), label, deps.saved, deps.connections, deps.audit).await?;
    p.done(Some(saved.label().to_owned()));

    instance.saved_connection_id = Some(saved.id().to_owned());
    instance.status = InstanceStatus::Running;
    deps.local.store.put(instance.clone())?;
    record(deps, EventKind::LocalInstanceCreated, &instance, None).await;
    if sample_data {
        record(
            deps,
            EventKind::SampleDataLoaded,
            &instance,
            sample_error.as_ref(),
        )
        .await;
    }
    p.start(Stage::Ready);
    p.done(None);
    Ok(LocalCreated {
        connection: saved,
        instance,
        sample_error: sample_error.map(|e| e.message().to_owned()),
        starter_sql: starter,
    })
}

fn new_instance(request: &LocalRequest, id: String, version: String) -> LocalInstance {
    LocalInstance {
        id,
        name: request.database.clone(),
        engine: request.engine,
        version,
        provider: request.provider,
        container_id: None,
        container_name: None,
        volume: None,
        data_path: None,
        service: None,
        host: HOST.into(),
        port: (request.provider != Provider::File).then_some(request.port),
        database: request.database.clone(),
        user: (request.provider != Provider::File).then(|| request.user.clone()),
        created_at: now_ms(),
        status: InstanceStatus::Creating,
        managed: request.provider == Provider::Docker,
        saved_connection_id: None,
        sample_data: SampleState::Off,
        uninstall: None,
    }
}

async fn create_sqlite(
    deps: &Deps<'_>,
    request: &LocalRequest,
    p: &Progress<'_>,
) -> Result<LocalCreated, CommandError> {
    p.start(Stage::CheckingRuntime);
    let path = sqlite_path(deps.local, &request.database);
    if path.exists() {
        return Err(invalid(format!(
            "{} already exists. Pick another name.",
            path.display()
        )));
    }
    p.done(Some("SQLite is built in".into()));

    p.start(Stage::CreatingStorage);
    std::fs::create_dir_all(deps.local.sqlite_dir()).map_err(|e| {
        CommandError::new(
            ErrorCode::PermissionDenied,
            format!("Couldn’t create {}: {e}", deps.local.sqlite_dir().display()),
        )
    })?;
    // Opening with create_if_missing makes the file; db::open never creates one
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    sqlx::SqlitePool::connect_with(options)
        .await
        .map_err(db::connect_failed)?
        .close()
        .await;
    let path_text = path.display().to_string();
    p.done(Some(path_text.clone()));

    let mut instance = new_instance(request, saved::new_id(), "bundled".into());
    instance.host = String::new();
    instance.data_path = Some(path_text.clone());
    deps.local.store.put(instance.clone())?;
    let connect = || ConnectRequest::Sqlite {
        path: path_text.clone(),
    };
    finish(deps, p, instance, &connect, request.sample_data).await
}

/// How long a first start may take: MySQL initializes its data directory before it listens.
fn health_timeout(engine: Engine) -> Duration {
    match engine {
        Engine::Postgres => Duration::from_secs(180),
        _ => Duration::from_secs(300),
    }
}

/// The last `lines` of a container's log, every password from its env masked.
async fn masked_logs(
    docker: &Docker,
    inspect: &Inspect,
    lines: u32,
) -> Result<String, CommandError> {
    let logs = docker.logs(&inspect.id, lines).await?;
    let secrets = inspect.secrets();
    let secrets: Vec<&str> = secrets.iter().map(String::as_str).collect();
    Ok(process::mask(&logs, &secrets))
}

async fn wait_healthy(
    docker: &Docker,
    id: &str,
    timeout: Duration,
    cancel: &Cancel,
) -> Result<(), CommandError> {
    let deadline = Instant::now() + timeout;
    loop {
        let Some(inspect) = docker.inspect(id).await? else {
            return Err(CommandError::new(
                ErrorCode::ContainerStopped,
                "The container disappeared while starting.",
            ));
        };
        match (inspect.state.status.as_str(), inspect.health()) {
            ("running", Some("healthy")) => return Ok(()),
            ("exited" | "dead" | "restarting", _) => {
                let logs = masked_logs(docker, &inspect, 20).await.unwrap_or_default();
                return Err(CommandError::new(
                    ErrorCode::ContainerStopped,
                    format!(
                        "The container stopped while starting. Its last log lines:\n{}",
                        logs.trim()
                    ),
                ));
            }
            _ => {}
        }
        if Instant::now() >= deadline {
            return Err(CommandError::new(
                ErrorCode::StartupTimeout,
                format!(
                    "The server didn’t pass its health check within {} seconds. Open its logs from Local servers to see why.",
                    timeout.as_secs()
                ),
            ));
        }
        if !cancel.sleep(Duration::from_secs(1)).await {
            return Err(CommandError::new(ErrorCode::Cancelled, "Cancelled."));
        }
    }
}

async fn create_docker(
    deps: &Deps<'_>,
    request: &LocalRequest,
    p: &Progress<'_>,
    cancel: &Cancel,
) -> Result<LocalCreated, CommandError> {
    let version = pinned_version(request.engine, &request.version)?;
    let image = image(request.engine, version.tag);
    let name = container_name(request);
    let volume = volume_name(&name);

    p.start(Stage::CheckingRuntime);
    let docker = Docker::require()?;
    let status = Docker::status().await;
    if let Some(problem) = status.problem {
        let code = match problem {
            docker::DockerProblem::NotInstalled => ErrorCode::DockerUnavailable,
            docker::DockerProblem::DaemonStopped => ErrorCode::DockerStopped,
            docker::DockerProblem::PermissionDenied => ErrorCode::DockerPermission,
        };
        return Err(CommandError::new(
            code,
            daemon_blocker(&status).unwrap_or_default(),
        ));
    }
    if !ports::port_free(request.port) {
        return Err(CommandError::new(
            ErrorCode::PortInUse,
            port_blocker(request.port),
        ));
    }
    if docker.inspect(&name).await?.is_some() {
        return Err(invalid(format!(
            "A container named {name} already exists. Pick another container name."
        )));
    }
    if docker.volume_labels(&volume).await?.is_some() {
        return Err(invalid(format!(
            "A volume named {volume} already exists. Pick another container name."
        )));
    }
    p.done(Some(format!(
        "Docker {}, port {} is free",
        status.server_version.as_deref().unwrap_or("?"),
        request.port
    )));

    if docker.image_present(&image).await {
        p.skip(
            Stage::PullingImage,
            &format!("{image} is already downloaded"),
        );
    } else {
        p.start(Stage::PullingImage);
        docker.pull(&image, cancel, |line| p.output(line)).await?;
        p.done(Some(image.clone()));
    }

    check_cancel(cancel)?;
    let id = saved::new_id();
    p.start(Stage::CreatingStorage);
    docker
        .create_volume(&id, &request.database, &volume)
        .await?;
    let mut instance = new_instance(request, id.clone(), version.tag.into());
    instance.container_name = Some(name.clone());
    instance.volume = Some(volume.clone());
    deps.local.store.put(instance.clone())?;
    p.done(Some(volume.clone()));

    // From here a failure keeps the instance (marked failed) so its logs can be read, while a
    // cancel removes the container and volume made above: they're new and hold nothing yet.
    let started = async {
        check_cancel(cancel)?;
        p.start(Stage::CreatingContainer);
        let container_id = docker
            .create(&ContainerSpec {
                instance_id: &id,
                engine: request.engine,
                image: &image,
                name: &name,
                volume: &volume,
                port: request.port,
                database: &request.database,
                user: &request.user,
                password: &request.password,
                root_password: &request.root_password,
            })
            .await?;
        instance.container_id = Some(container_id[..container_id.len().min(12)].to_owned());
        deps.local.store.put(instance.clone())?;
        p.done(Some(name.clone()));

        check_cancel(cancel)?;
        p.start(Stage::Starting);
        docker.lifecycle("start", &container_id).await?;
        p.done(None);

        p.start(Stage::WaitingForHealth);
        wait_healthy(
            &docker,
            &container_id,
            health_timeout(request.engine),
            cancel,
        )
        .await?;
        p.done(None);
        Ok::<_, CommandError>(())
    }
    .await;
    if let Err(error) = started {
        if error.code() == ErrorCode::Cancelled {
            if let Some(container) = &instance.container_id {
                let _ = docker.remove_container(container).await;
            }
            let _ = docker.remove_volume(&volume).await;
            deps.local.store.remove(&id)?;
        } else {
            instance.status = InstanceStatus::Failed;
            deps.local.store.put(instance.clone())?;
            record(
                deps,
                EventKind::LocalInstanceCreated,
                &instance,
                Some(&error),
            )
            .await;
        }
        return Err(error);
    }

    let (engine, port) = (request.engine, request.port);
    let (user, password, database) = (
        request.user.clone(),
        request.password.clone(),
        request.database.clone(),
    );
    let connect = move || server_request(engine, port, &user, &password, &database);
    finish(deps, p, instance, &connect, request.sample_data).await
}

/// Waits until something answers on 127.0.0.1:`port`.
async fn wait_for_port(port: u16, timeout: Duration) -> Result<(), CommandError> {
    let deadline = Instant::now() + timeout;
    while ports::probe(port).await.is_none() {
        if Instant::now() >= deadline {
            return Err(CommandError::new(
                ErrorCode::StartupTimeout,
                format!(
                    "Nothing answered on port {port} within {} seconds. Check the service in your OS’s service manager.",
                    timeout.as_secs()
                ),
            ));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    Ok(())
}

/// Creates the app user and database as the server admin (see native::Setup).
async fn native_setup(
    setup: &native::Setup,
    request: &LocalRequest,
    port: u16,
    on_line: &(dyn Fn(&str) + Sync),
) -> Result<(), CommandError> {
    let (engine, database, user, password) = (
        request.engine,
        &request.database,
        &request.user,
        &request.password,
    );
    match setup {
        native::Setup::Client(step) => {
            let sql = native::setup_sql(engine, database, user, password);
            native::run_step(step, Some(sql), native::SERVICE_TIMEOUT, on_line).await
        }
        native::Setup::Sqlx {
            user: admin,
            password: admin_password,
            database: admin_db,
        } => {
            let connect = || server_request(engine, port, admin, admin_password, admin_db);
            let open = open_with_retry(&connect, 10).await?;
            let result = async {
                match &open.pool {
                    Pool::Postgres(p) => {
                        // Names are validated identifiers and the password has no quotes (types.rs)
                        sqlx::raw_sql(sqlx::AssertSqlSafe(native::pg_role_sql(user, password)))
                            .execute(p)
                            .await?;
                        let exists: Option<i32> =
                            sqlx::query_scalar("SELECT 1 FROM pg_database WHERE datname = $1")
                                .bind(database)
                                .fetch_optional(p)
                                .await?;
                        if exists.is_none() {
                            sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                                "CREATE DATABASE {database} OWNER {user}"
                            )))
                            .execute(p)
                            .await?;
                        }
                    }
                    Pool::Mysql(p) => {
                        sqlx::raw_sql(sqlx::AssertSqlSafe(native::setup_sql(
                            engine, database, user, password,
                        )))
                        .execute(p)
                        .await?;
                    }
                    Pool::Sqlite(_) | Pool::Mssql(_) => {
                        unreachable!("native servers are Postgres or MySQL-family")
                    }
                }
                Ok::<_, sqlx::Error>(())
            }
            .await;
            open.close().await;
            result.map_err(db::query_failed)
        }
    }
}

/// Installs a server with the package manager, after checking the user approved these exact
/// commands. Not cancellable: interrupting a package manager can leave a broken install.
async fn create_native(
    deps: &Deps<'_>,
    request: &LocalRequest,
    p: &Progress<'_>,
) -> Result<LocalCreated, CommandError> {
    let recipe = native_recipe(request);
    if !recipe.supported {
        let mut message = recipe.notes.join(" ");
        if !recipe.manual.is_empty() {
            message = format!("{message}\n{}", recipe.manual.join("\n"));
        }
        return Err(CommandError::new(ErrorCode::NativeUnsupported, message));
    }
    if recipe.needs_root_password {
        types::check_password(&request.root_password, "Admin password")?;
    }
    let consent =
        native::to_plan(&recipe, request.engine, &request.database, &request.user).consent_token;
    if request.consent.as_deref() != Some(consent.as_str()) {
        return Err(invalid(
            "Approve the install commands first; they changed since you reviewed them.",
        ));
    }
    p.no_cancel();

    p.start(Stage::CheckingRuntime);
    if ports::probe(recipe.port).await.is_some() || !ports::port_free(recipe.port) {
        return Err(CommandError::new(
            ErrorCode::PortInUse,
            format!(
                "Something already listens on port {}. Use Connect existing if it’s a database server.",
                recipe.port
            ),
        ));
    }
    p.done(recipe.manager.map(|m| m.name().to_owned()));

    let mut instance = new_instance(request, saved::new_id(), recipe.version.clone());
    instance.port = Some(recipe.port);
    instance.service = recipe.service.clone();
    instance.data_path = recipe.data_dir.clone();
    instance.uninstall = recipe.uninstall.clone();
    instance.managed = true;
    deps.local.store.put(instance.clone())?;

    let on_line = |line: &str| p.output(line);
    let installed = async {
        p.start(Stage::Installing);
        for step in &recipe.install {
            let result = native::run_step(step, None, native::INSTALL_TIMEOUT, &on_line).await;
            record(
                deps,
                EventKind::NativeInstallRun,
                &instance,
                result.as_ref().err(),
            )
            .await;
            result?;
        }
        p.done(None);
        if recipe.start.is_empty() {
            p.skip(Stage::Starting, "The installer started the service");
        } else {
            p.start(Stage::Starting);
            for step in &recipe.start {
                native::run_step(step, None, native::SERVICE_TIMEOUT, &on_line).await?;
            }
            p.done(recipe.service.clone());
        }
        p.start(Stage::WaitingForHealth);
        wait_for_port(recipe.port, Duration::from_secs(120)).await?;
        p.done(None);
        p.start(Stage::CreatingDatabase);
        if let Some(setup) = &recipe.setup {
            native_setup(setup, request, recipe.port, &on_line).await?;
        }
        p.done(Some(format!(
            "{} owned by {}",
            request.database, request.user
        )));
        Ok::<_, CommandError>(())
    }
    .await;
    if let Err(error) = installed {
        instance.status = InstanceStatus::Failed;
        deps.local.store.put(instance.clone())?;
        return Err(error);
    }

    let (engine, port) = (request.engine, recipe.port);
    let (user, password, database) = (
        request.user.clone(),
        request.password.clone(),
        request.database.clone(),
    );
    let connect = move || server_request(engine, port, &user, &password, &database);
    finish(deps, p, instance, &connect, request.sample_data).await
}

/// Runs a provisioning end to end. Tauri-free, so the Docker integration tests drive it too.
pub(crate) async fn create(
    deps: &Deps<'_>,
    provisioning_id: &str,
    request: &LocalRequest,
    emit: &(dyn Fn(LocalProgress) + Send + Sync),
) -> Result<LocalCreated, CommandError> {
    types::check_resource_name(provisioning_id, "Provisioning id")?;
    request.validate()?;
    let cancel = Arc::new(Cancel::default());
    deps.local
        .running()
        .insert(provisioning_id.to_owned(), cancel.clone());
    let p = Progress::new(provisioning_id.to_owned(), emit);
    let result = match request.provider {
        Provider::File => create_sqlite(deps, request, &p).await,
        Provider::Docker => create_docker(deps, request, &p, &cancel).await,
        Provider::Native => create_native(deps, request, &p).await,
    };
    deps.local.running().remove(provisioning_id);
    if let Err(error) = &result {
        p.fail(error.message());
    }
    result
}

/// Creates a local database, sending `LocalProgress` events as each stage starts and ends.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn create_local_database(
    provisioning_id: String,
    request: LocalRequest,
    app: AppHandle,
    local: State<'_, Local>,
    saved: State<'_, Saved>,
    connections: State<'_, Connections>,
    audit: State<'_, Audit>,
) -> Result<LocalCreated, CommandError> {
    let deps = Deps {
        local: &local,
        saved: &saved,
        connections: &connections,
        audit: &audit,
    };
    let emit = move |event: LocalProgress| {
        let _ = event.emit(&app);
    };
    create(&deps, &provisioning_id, &request, &emit).await
}

/// Stops a provisioning at the next safe point. A no-op once it can no longer be cancelled.
#[tauri::command]
#[specta::specta]
pub fn cancel_provisioning(provisioning_id: String, local: State<'_, Local>) {
    if let Some(cancel) = local.running().get(&provisioning_id) {
        cancel.cancel();
    }
}

// --- Lifecycle -------------------------------------------------------------------------------

/// The instance's container, refused unless it carries this instance's QueryCraft labels.
async fn managed_container(
    docker: &Docker,
    instance: &LocalInstance,
) -> Result<Inspect, CommandError> {
    let id = instance
        .container_id
        .as_deref()
        .or(instance.container_name.as_deref())
        .ok_or_else(|| invalid("This local database has no container (it was removed)."))?;
    let inspect = docker.inspect(id).await?.ok_or_else(|| {
        CommandError::new(
            ErrorCode::ContainerStopped,
            "The container is gone: it was removed outside QueryCraft.",
        )
    })?;
    docker::check_managed(inspect.config.labels.as_ref(), &instance.id, "container")?;
    Ok(inspect)
}

fn docker_status_of(inspect: &Inspect) -> InstanceStatus {
    match (inspect.state.status.as_str(), inspect.health()) {
        ("running", Some("starting")) | ("restarting", _) => InstanceStatus::Starting,
        ("running", Some("unhealthy")) | ("dead", _) => InstanceStatus::Failed,
        ("running", _) => InstanceStatus::Running,
        _ => InstanceStatus::Stopped,
    }
}

/// Reads the live state of each instance (container state, file presence, a listening port).
async fn refresh(mut instances: Vec<LocalInstance>) -> Vec<LocalInstance> {
    let docker = instances
        .iter()
        .any(|i| i.provider == Provider::Docker)
        .then(Docker::locate)
        .flatten();
    let docker_up = match &docker {
        Some(_) => Docker::status().await.daemon_running,
        None => false,
    };
    for instance in &mut instances {
        if instance.status == InstanceStatus::Creating || instance.status == InstanceStatus::Removed
        {
            continue;
        }
        instance.status = match instance.provider {
            Provider::Docker => match (&docker, docker_up) {
                (Some(docker), true) => match managed_container(docker, instance).await {
                    Ok(inspect) => docker_status_of(&inspect),
                    Err(_) => InstanceStatus::Missing,
                },
                _ => InstanceStatus::Unknown,
            },
            Provider::File => match instance.data_path.as_deref().map(Path::new) {
                Some(path) if path.exists() => InstanceStatus::Running,
                _ => InstanceStatus::Missing,
            },
            Provider::Native => match instance.port {
                Some(port) if ports::probe(port).await.is_some() => InstanceStatus::Running,
                _ => InstanceStatus::Stopped,
            },
        };
    }
    instances
}

#[tauri::command]
#[specta::specta]
pub async fn list_local_instances(
    local: State<'_, Local>,
) -> Result<Vec<LocalInstance>, CommandError> {
    Ok(refresh(local.store.snapshot()).await)
}

async fn refreshed(local: &Local, id: &str) -> Result<LocalInstance, CommandError> {
    let instance = local.store.get(id)?;
    Ok(refresh(vec![instance]).await.remove(0))
}

#[derive(Clone, Copy)]
enum Lifecycle {
    Start,
    Stop,
    Restart,
}

async fn lifecycle(
    deps: &Deps<'_>,
    id: &str,
    action: Lifecycle,
) -> Result<LocalInstance, CommandError> {
    let instance = deps.local.store.get(id)?;
    let verb = match action {
        Lifecycle::Start => "start",
        Lifecycle::Stop => "stop",
        Lifecycle::Restart => "restart",
    };
    let result = match instance.provider {
        Provider::Docker => {
            let docker = Docker::require()?;
            let inspect = managed_container(&docker, &instance).await?;
            docker.lifecycle(verb, &inspect.id).await
        }
        Provider::Native => {
            let service = instance
                .service
                .as_deref()
                .ok_or_else(|| invalid("This install has no service name."))?;
            let os = Os::current();
            let (_, brew_prefix, _) = native::detect(os);
            let step = native::service_step(os, &brew_prefix, service, verb)?;
            native::run_step(&step, None, native::SERVICE_TIMEOUT, &|_| {}).await
        }
        Provider::File => {
            return Err(invalid(
                "A SQLite database is a file; there is no server to start or stop.",
            ));
        }
    };
    let kind = match action {
        Lifecycle::Stop => EventKind::LocalInstanceStopped,
        _ => EventKind::LocalInstanceStarted,
    };
    record(deps, kind, &instance, result.as_ref().err()).await;
    result?;
    refreshed(deps.local, id).await
}

macro_rules! lifecycle_command {
    ($name:ident, $action:expr, $doc:literal) => {
        #[doc = $doc]
        #[tauri::command]
        #[specta::specta]
        pub async fn $name(
            id: String,
            local: State<'_, Local>,
            saved: State<'_, Saved>,
            connections: State<'_, Connections>,
            audit: State<'_, Audit>,
        ) -> Result<LocalInstance, CommandError> {
            let deps = Deps {
                local: &local,
                saved: &saved,
                connections: &connections,
                audit: &audit,
            };
            lifecycle(&deps, &id, $action).await
        }
    };
}

lifecycle_command!(
    start_local_database,
    Lifecycle::Start,
    "Starts a QueryCraft-managed instance."
);
lifecycle_command!(
    stop_local_database,
    Lifecycle::Stop,
    "Stops a QueryCraft-managed instance."
);
lifecycle_command!(
    restart_local_database,
    Lifecycle::Restart,
    "Restarts a QueryCraft-managed instance."
);

/// The last `lines` lines of the server's log, passwords masked.
#[tauri::command]
#[specta::specta]
pub async fn local_database_logs(
    id: String,
    lines: u32,
    local: State<'_, Local>,
) -> Result<String, CommandError> {
    let instance = local.store.get(&id)?;
    match instance.provider {
        Provider::Docker => {
            let docker = Docker::require()?;
            let inspect = managed_container(&docker, &instance).await?;
            masked_logs(&docker, &inspect, lines.clamp(1, MAX_LOG_LINES)).await
        }
        Provider::Native => Err(CommandError::new(
            ErrorCode::NativeUnsupported,
            "QueryCraft doesn’t read a natively installed server’s logs; see your OS service manager.",
        )),
        Provider::File => Err(invalid("A SQLite database has no server log.")),
    }
}

/// Removes the container (or forgets a native/SQLite instance). The data is kept: the Docker
/// volume, the native server, the SQLite file.
pub(crate) async fn remove(deps: &Deps<'_>, id: &str) -> Result<(), CommandError> {
    let mut instance = deps.local.store.get(id)?;
    if instance.provider == Provider::Docker && instance.status != InstanceStatus::Removed {
        let docker = Docker::require()?;
        match managed_container(&docker, &instance).await {
            Ok(inspect) => docker.remove_container(&inspect.id).await?,
            // Already gone is fine; anything not ours is refused
            Err(e) if e.code() == ErrorCode::ContainerStopped => {}
            Err(e) => return Err(e),
        }
        instance.container_id = None;
        instance.status = InstanceStatus::Removed;
        deps.local.store.put(instance.clone())?;
    } else if instance.provider != Provider::Docker {
        deps.local.store.remove(id)?;
    }
    record(deps, EventKind::LocalInstanceRemoved, &instance, None).await;
    Ok(())
}

/// Deletes the instance's data for good: the Docker volume (and container) or the SQLite file.
/// `confirm` must be the database name, typed by the user.
pub(crate) async fn delete_data(
    deps: &Deps<'_>,
    id: &str,
    confirm: &str,
) -> Result<(), CommandError> {
    let instance = deps.local.store.get(id)?;
    if confirm != instance.database {
        return Err(invalid(format!("Type {} to confirm.", instance.database)));
    }
    match instance.provider {
        Provider::Docker => {
            let docker = Docker::require()?;
            match managed_container(&docker, &instance).await {
                Ok(inspect) => docker.remove_container(&inspect.id).await?,
                Err(e)
                    if e.code() == ErrorCode::ContainerStopped
                        || instance.container_id.is_none() => {}
                Err(e) => return Err(e),
            }
            if let Some(volume) = &instance.volume
                && let Some(labels) = docker.volume_labels(volume).await?
            {
                docker::check_managed(Some(&labels), &instance.id, "volume")?;
                docker.remove_volume(volume).await?;
            }
        }
        Provider::File => {
            let path = instance
                .data_path
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or_default();
            // Only files QueryCraft made, in its own databases folder
            if path.parent() != Some(deps.local.sqlite_dir().as_path()) {
                return Err(CommandError::new(
                    ErrorCode::NotManaged,
                    "That file isn’t in QueryCraft’s databases folder, so it wasn’t deleted.",
                ));
            }
            if let Some(saved_id) = &instance.saved_connection_id
                && let Some(open) = deps.connections.remove(saved_id)
            {
                // The pool holds the file open; Windows can't delete it until it's closed
                open.close().await;
            }
            for suffix in ["", "-wal", "-shm", "-journal"] {
                let file = PathBuf::from(format!("{}{suffix}", path.display()));
                if file.exists() {
                    std::fs::remove_file(&file).map_err(|e| {
                        CommandError::new(
                            ErrorCode::PermissionDenied,
                            format!("Couldn’t delete {}: {e}", file.display()),
                        )
                    })?;
                }
            }
        }
        Provider::Native => {
            return Err(CommandError::new(
                ErrorCode::NativeUnsupported,
                "QueryCraft doesn’t delete a native server’s data. Uninstall it with your package manager.",
            ));
        }
    }
    if let Some(saved_id) = &instance.saved_connection_id {
        saved::forget(saved_id, deps.saved, deps.connections, deps.audit).await?;
    }
    deps.local.store.remove(id)?;
    record(deps, EventKind::LocalDataDeleted, &instance, None).await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn remove_local_database(
    id: String,
    local: State<'_, Local>,
    saved: State<'_, Saved>,
    connections: State<'_, Connections>,
    audit: State<'_, Audit>,
) -> Result<(), CommandError> {
    let deps = Deps {
        local: &local,
        saved: &saved,
        connections: &connections,
        audit: &audit,
    };
    remove(&deps, &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_local_database_data(
    id: String,
    confirm: String,
    local: State<'_, Local>,
    saved: State<'_, Saved>,
    connections: State<'_, Connections>,
    audit: State<'_, Audit>,
) -> Result<(), CommandError> {
    let deps = Deps {
        local: &local,
        saved: &saved,
        connections: &connections,
        audit: &audit,
    };
    delete_data(&deps, &id, &confirm).await
}

// --- Existing databases ----------------------------------------------------------------------

/// The request and label that reach a target, and whether its password is known.
/// Passwords recovered from a container's env stay in this request: tested, saved to the
/// credential store, never returned.
async fn resolve(
    deps: &Deps<'_>,
    target: &LocalTarget,
    login: Option<&LocalLogin>,
) -> Result<(Option<ConnectRequest>, String, Engine), CommandError> {
    if let Some(login) = login {
        db::require(&login.user, "User")?;
    }
    match target {
        LocalTarget::Instance { id } => {
            let instance = deps.local.store.get(id)?;
            let label = connection_label(&instance);
            // Its saved connection has the password in the credential store
            if let Some(saved_id) = &instance.saved_connection_id
                && login.is_none()
                && let Ok(request) = deps.saved.request(saved_id).await
            {
                return Ok((Some(request), label, instance.engine));
            }
            match (instance.provider, login) {
                (Provider::File, _) => Ok((
                    Some(ConnectRequest::Sqlite {
                        path: instance.data_path.clone().unwrap_or_default(),
                    }),
                    label,
                    instance.engine,
                )),
                (_, Some(login)) => {
                    let port = instance.port.unwrap_or_default();
                    Ok((
                        Some(server_request(
                            instance.engine,
                            port,
                            &login.user,
                            &login.password,
                            &login.database,
                        )),
                        label,
                        instance.engine,
                    ))
                }
                (Provider::Docker, None) => {
                    let docker = Docker::require()?;
                    let inspect = managed_container(&docker, &instance).await?;
                    let env = docker::login_from_env(instance.engine, &inspect.env());
                    let port = instance.port.unwrap_or_default();
                    let request = env.password.map(|password| {
                        server_request(
                            instance.engine,
                            port,
                            &env.user,
                            &password,
                            &instance.database,
                        )
                    });
                    Ok((request, label, instance.engine))
                }
                (Provider::Native, None) => Ok((None, label, instance.engine)),
            }
        }
        LocalTarget::Container { id } => {
            types::check_resource_name(id, "Container id")?;
            let docker = Docker::require()?;
            let inspect = docker
                .inspect(id)
                .await?
                .ok_or_else(|| invalid("That container no longer exists."))?;
            let found = docker::describe(&inspect).ok_or_else(|| {
                invalid("That container doesn’t run PostgreSQL, MySQL or MariaDB.")
            })?;
            if found.state != "running" {
                return Err(invalid(format!(
                    "{} isn’t running. Start it first (docker start {}).",
                    found.name, found.name
                )));
            }
            let port = found.host_port.ok_or_else(|| {
                invalid(format!(
                    "{} doesn’t publish its port to this machine, so QueryCraft can’t reach it.",
                    found.name
                ))
            })?;
            let env = docker::login_from_env(found.engine, &inspect.env());
            let label = format!(
                "{} · {}",
                if env.database.is_empty() {
                    &env.user
                } else {
                    &env.database
                },
                found.name
            );
            let request = match login {
                Some(login) => Some(server_request(
                    found.engine,
                    port,
                    &login.user,
                    &login.password,
                    &login.database,
                )),
                None => env.password.map(|password| {
                    server_request(found.engine, port, &env.user, &password, &env.database)
                }),
            };
            Ok((request, label, found.engine))
        }
        LocalTarget::Native { engine, port } => {
            types::check_port(*port)?;
            let label = format!("{} :{port}", engine_name(*engine));
            let request = login.map(|login| {
                server_request(
                    *engine,
                    *port,
                    &login.user,
                    &login.password,
                    &login.database,
                )
            });
            Ok((request, label, *engine))
        }
    }
}

const NEEDS_CREDENTIALS: &str =
    "QueryCraft couldn’t recover this server’s password. Enter the user and password to connect.";

/// Tries to sign in to an existing local database without saving anything.
#[tauri::command]
#[specta::specta]
pub async fn test_local_database(
    target: LocalTarget,
    login: Option<LocalLogin>,
    local: State<'_, Local>,
    saved: State<'_, Saved>,
    connections: State<'_, Connections>,
    audit: State<'_, Audit>,
) -> Result<TestOutcome, CommandError> {
    let deps = Deps {
        local: &local,
        saved: &saved,
        connections: &connections,
        audit: &audit,
    };
    let (request, _, _) = resolve(&deps, &target, login.as_ref()).await?;
    let Some(request) = request else {
        return Ok(TestOutcome {
            ok: false,
            message: NEEDS_CREDENTIALS.into(),
            needs_credentials: true,
        });
    };
    Ok(match db::open(request).await {
        Ok(open) => {
            open.close().await;
            TestOutcome {
                ok: true,
                message: "Connected.".into(),
                needs_credentials: false,
            }
        }
        Err(e) => TestOutcome {
            needs_credentials: e.code() == ErrorCode::InvalidCredentials,
            ok: false,
            message: e.message().to_owned(),
        },
    })
}

/// Saves a connection to an existing local database (a discovered container or native server,
/// or a QueryCraft instance whose connection was removed). Validated by connecting first.
#[tauri::command]
#[specta::specta]
pub async fn connect_local_database(
    target: LocalTarget,
    login: Option<LocalLogin>,
    local: State<'_, Local>,
    saved: State<'_, Saved>,
    connections: State<'_, Connections>,
    audit: State<'_, Audit>,
) -> Result<SavedConnection, CommandError> {
    let deps = Deps {
        local: &local,
        saved: &saved,
        connections: &connections,
        audit: &audit,
    };
    let (request, label, _) = resolve(&deps, &target, login.as_ref()).await?;
    let request = request
        .ok_or_else(|| CommandError::new(ErrorCode::InvalidCredentials, NEEDS_CREDENTIALS))?;
    let connection = saved::save_connection(request, label, &saved, &connections, &audit).await?;
    if let LocalTarget::Instance { id } = &target {
        let mut instance = local.store.get(id)?;
        instance.saved_connection_id = Some(connection.id().to_owned());
        local.store.put(instance)?;
    }
    Ok(connection)
}

/// Loads (or finishes loading) the sample data into an instance. Safe to repeat.
pub(crate) async fn init_sample(deps: &Deps<'_>, id: &str) -> Result<SampleOutcome, CommandError> {
    let mut instance = deps.local.store.get(id)?;
    let (request, _, _) = resolve(deps, &LocalTarget::Instance { id: id.to_owned() }, None).await?;
    let request = request
        .ok_or_else(|| CommandError::new(ErrorCode::InvalidCredentials, NEEDS_CREDENTIALS))?;
    let open = db::open(request).await?;
    let loaded = sample::load(&open.pool).await;
    let starter = sample::starter_sql(&open.pool).to_owned();
    open.close().await;
    instance.sample_data = if loaded.is_ok() {
        SampleState::Loaded
    } else {
        SampleState::Failed
    };
    deps.local.store.put(instance.clone())?;
    record(
        deps,
        EventKind::SampleDataLoaded,
        &instance,
        loaded.as_ref().err(),
    )
    .await;
    loaded?;
    Ok(SampleOutcome {
        instance,
        starter_sql: starter,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn init_sample_data(
    id: String,
    local: State<'_, Local>,
    saved: State<'_, Saved>,
    connections: State<'_, Connections>,
    audit: State<'_, Audit>,
) -> Result<SampleOutcome, CommandError> {
    let deps = Deps {
        local: &local,
        saved: &saved,
        connections: &connections,
        audit: &audit,
    };
    init_sample(&deps, &id).await
}

#[cfg(test)]
mod tests;
