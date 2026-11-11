//! End-to-end tests of provisioning. SQLite runs everywhere; the Docker ones are `#[ignore]`d
//! and run with `cargo test -- --ignored` on a machine with Docker running. They only touch
//! containers and volumes they create (QueryCraft-labelled, `qc-test-*`), and remove them.

use super::*;
use crate::audit::tests::temp_dir;
use crate::local::types::tests::request;

struct Env {
    dir: PathBuf,
    local: Local,
    saved: Saved,
    connections: Connections,
    audit: Audit,
}

impl Env {
    async fn new() -> Self {
        let dir = temp_dir();
        Self {
            local: Local::load(dir.clone()),
            saved: Saved::load(dir.clone()),
            connections: Connections::default(),
            audit: Audit::open(&dir).await,
            dir,
        }
    }

    fn deps(&self) -> Deps<'_> {
        Deps {
            local: &self.local,
            saved: &self.saved,
            connections: &self.connections,
            audit: &self.audit,
        }
    }
}

/// Collects progress events for assertions.
#[derive(Default)]
struct Events(Mutex<Vec<LocalProgress>>);

impl Events {
    fn emit(&self) -> impl Fn(LocalProgress) + Send + Sync + '_ {
        |event| self.0.lock().unwrap().push(event)
    }

    fn stages(&self, state: StageState) -> Vec<Stage> {
        let events = self.0.lock().unwrap();
        events
            .iter()
            .filter(|e| e.state == state)
            .map(|e| e.stage)
            .collect()
    }
}

#[tokio::test]
async fn creates_a_sqlite_database_with_sample_data_then_deletes_it() {
    let env = Env::new().await;
    let deps = env.deps();
    let events = Events::default();
    let mut req = request(Engine::Sqlite, Provider::File);
    req.database = "shop_demo".into();

    let plan = plan(&env.local, &req).await.unwrap();
    assert!(plan.blockers.is_empty() && plan.storage.ends_with("shop_demo.db"));

    let created = create(&deps, "p-1", &req, &events.emit()).await.unwrap();
    assert!(created.sample_error.is_none());
    assert!(
        created
            .starter_sql
            .unwrap()
            .contains("Customers with no orders")
    );
    assert_eq!(created.instance.status, InstanceStatus::Running);
    assert_eq!(created.instance.sample_data, SampleState::Loaded);
    assert!(env.connections.is_open(created.connection.id()));
    assert_eq!(
        events.stages(StageState::Done),
        [
            Stage::CheckingRuntime,
            Stage::CreatingStorage,
            Stage::InitializingSampleData,
            Stage::Validating,
            Stage::RegisteringConnection,
            Stage::Ready
        ]
    );

    // The same name again is refused, by the plan and by create
    assert!(!plan_blockers(&env, &req).await.is_empty());
    assert!(create(&deps, "p-2", &req, &events.emit()).await.is_err());

    // Retrying the sample data is idempotent
    let id = created.instance.id.clone();
    init_sample(&deps, &id).await.unwrap();
    let open = db::open(env.saved.request(created.connection.id()).await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        sample::row_counts(&open.pool).await.unwrap(),
        sample::EXPECTED_ROWS
    );
    open.close().await;

    // Deleting data needs the typed name, then removes the file and the saved connection
    assert!(delete_data(&deps, &id, "wrong").await.is_err());
    let path = PathBuf::from(created.instance.data_path.unwrap());
    assert!(path.exists());
    delete_data(&deps, &id, "shop_demo").await.unwrap();
    assert!(!path.exists());
    assert!(env.local.store.snapshot().is_empty());
    assert!(env.saved.request(created.connection.id()).await.is_err());

    let audit = crate::audit::tests::file_text(env.audit, &env.dir).await;
    for event in [
        "local_instance_created",
        "sample_data_loaded",
        "local_data_deleted",
    ] {
        assert!(audit.contains(event), "{event}");
    }
    let _ = std::fs::remove_dir_all(env.dir);
}

async fn plan_blockers(env: &Env, req: &LocalRequest) -> Vec<String> {
    plan(&env.local, req).await.unwrap().blockers
}

#[tokio::test]
async fn plans_flag_a_taken_port_with_a_suggestion() {
    let env = Env::new().await;
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let mut req = request(Engine::Postgres, Provider::Docker);
    req.port = listener.local_addr().unwrap().port();
    let plan = plan(&env.local, &req).await.unwrap();
    assert!(!plan.port_free);
    assert!(plan.suggested_port.is_some_and(|p| p > req.port));
    assert!(plan.blockers.iter().any(|b| b.contains("in use")));
    assert_eq!(plan.image.as_deref(), Some("postgres:17.11"));
    assert_eq!(
        plan.container_name.as_deref(),
        Some(format!("querycraft-postgres-{}", req.port).as_str())
    );
    let _ = std::fs::remove_dir_all(env.dir);
}

#[tokio::test]
async fn rejects_invalid_requests_before_doing_anything() {
    let env = Env::new().await;
    let mut req = request(Engine::Mysql, Provider::Docker);
    req.container_name = "bad name; rm".into();
    let Err(error) = create(&env.deps(), "p-3", &req, &|_| {}).await else {
        panic!("an invalid request was accepted");
    };
    assert_eq!(error.code(), ErrorCode::InvalidInput);
    assert!(env.local.store.snapshot().is_empty());
    let _ = std::fs::remove_dir_all(env.dir);
}

// --- Docker (run with --ignored) -------------------------------------------------------------

/// Removes the test's container and volume even when an assertion failed.
struct DockerCleanup(String);

impl Drop for DockerCleanup {
    fn drop(&mut self) {
        let docker = docker_path();
        let _ = std::process::Command::new(&docker)
            .args(["rm", "--force", &self.0])
            .output();
        let _ = std::process::Command::new(&docker)
            .args(["volume", "rm", &format!("{}-data", self.0)])
            .output();
    }
}

fn docker_path() -> PathBuf {
    process::find_program("docker", &[]).expect("docker on PATH")
}

async fn docker_round_trip(engine: Engine, base_port: u16) {
    let env = Env::new().await;
    let deps = env.deps();
    let events = Events::default();
    let mut req = request(engine, Provider::Docker);
    req.port = ports::next_free(base_port, ports::port_free).expect("a free port");
    req.container_name = format!("qc-test-{}-{}", engine_slug(engine), saved::new_id());
    let _cleanup = DockerCleanup(req.container_name.clone());

    let plan = plan(&env.local, &req).await.unwrap();
    assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);

    let created = create(&deps, "it", &req, &events.emit())
        .await
        .unwrap_or_else(|e| panic!("{}", e.message()));
    assert!(created.sample_error.is_none(), "{:?}", created.sample_error);
    assert!(
        events
            .stages(StageState::Done)
            .contains(&Stage::WaitingForHealth)
    );

    // Connect as the app user and count the sample rows
    let open = db::open(env.saved.request(created.connection.id()).await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        sample::row_counts(&open.pool).await.unwrap(),
        sample::EXPECTED_ROWS
    );
    open.close().await;
    // Loading it again changes nothing
    init_sample(&deps, &created.instance.id).await.unwrap();

    // Discovery sees it as managed, without its password
    let docker = Docker::require().unwrap();
    let found: Vec<_> = docker
        .database_containers()
        .await
        .unwrap()
        .iter()
        .filter_map(docker::describe)
        .collect();
    let mine = found
        .iter()
        .find(|c| c.name == req.container_name)
        .expect("discovered");
    assert!(mine.managed && mine.password_known && mine.host_port == Some(req.port));
    assert_eq!(mine.host_ip.as_deref(), Some("127.0.0.1"));

    let id = created.instance.id.clone();
    let logs = masked_logs(
        &docker,
        &managed_container(&docker, &created.instance).await.unwrap(),
        200,
    )
    .await
    .unwrap();
    assert!(!logs.contains(&req.password) && !logs.contains(&req.root_password));

    let stopped = lifecycle(&deps, &id, Lifecycle::Stop).await.unwrap();
    assert_eq!(stopped.status, InstanceStatus::Stopped);
    lifecycle(&deps, &id, Lifecycle::Start).await.unwrap();

    // Remove keeps the volume; delete data removes it and the saved connection
    remove(&deps, &id).await.unwrap();
    assert!(docker.inspect(&req.container_name).await.unwrap().is_none());
    assert!(
        docker
            .volume_labels(&format!("{}-data", req.container_name))
            .await
            .unwrap()
            .is_some()
    );
    delete_data(&deps, &id, &req.database).await.unwrap();
    assert!(
        docker
            .volume_labels(&format!("{}-data", req.container_name))
            .await
            .unwrap()
            .is_none()
    );
    assert!(env.saved.request(created.connection.id()).await.is_err());
    let _ = std::fs::remove_dir_all(env.dir);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn docker_postgres_round_trip() {
    docker_round_trip(Engine::Postgres, 55432).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn docker_mysql_round_trip() {
    docker_round_trip(Engine::Mysql, 53306).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn docker_mariadb_round_trip() {
    docker_round_trip(Engine::Mariadb, 53406).await;
}

/// Never touches a container without QueryCraft's labels: stop and remove are refused.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn refuses_to_manage_an_unlabelled_container() {
    let env = Env::new().await;
    let docker = Docker::require().unwrap();
    let name = format!("qc-test-unlabelled-{}", saved::new_id());
    let _cleanup = DockerCleanup(name.clone());
    let out = std::process::Command::new(docker_path())
        .args([
            "create",
            "--name",
            &name,
            "-e",
            "POSTGRES_PASSWORD=x12345678",
            "postgres:17.11",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    // A record that points at it, as if the instance list had been edited
    let mut instance = new_instance(
        &request(Engine::Postgres, Provider::Docker),
        "fake".into(),
        "17.11".into(),
    );
    instance.container_name = Some(name.clone());
    instance.status = InstanceStatus::Stopped;
    env.local.store.put(instance).unwrap();

    let deps = env.deps();
    assert_eq!(
        lifecycle(&deps, "fake", Lifecycle::Start)
            .await
            .unwrap_err()
            .code(),
        ErrorCode::NotManaged
    );
    assert_eq!(
        remove(&deps, "fake").await.unwrap_err().code(),
        ErrorCode::NotManaged
    );
    assert!(docker.inspect(&name).await.unwrap().is_some());
    let _ = std::fs::remove_dir_all(env.dir);
}
