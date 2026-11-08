//! Local databases: create, discover and manage database servers on this machine.
//!
//! Providers: Docker (recommended for servers on every OS), a native install through the OS
//! package manager (only after the user approved the exact commands), and SQLite files.
//! The UI only reaches this through the narrow commands below; every input is validated here.

mod docker;
mod ports;
mod process;
mod types;

use serde::Serialize;
use specta::Type;

pub use docker::{DiscoveredContainer, DockerStatus};
pub use types::*;

use docker::Docker;

/// Ports the native discovery checks: each engine's default and the next two.
const NATIVE_PORTS: [u16; 6] = [5432, 5433, 5434, 3306, 3307, 3308];

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
