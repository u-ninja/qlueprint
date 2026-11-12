//! `<app data>/local_instances.json`: the local databases QluePrint created. No secrets: the
//! passwords live in the OS credential store under the saved connection's id.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use super::types::LocalInstance;
use crate::db::{CommandError, ErrorCode};
use crate::saved::write_json;

const FILE: &str = "local_instances.json";

pub(crate) struct Store {
    file: PathBuf,
    // Held only to read or swap the list, never across an await.
    list: Mutex<Vec<LocalInstance>>,
}

impl Store {
    pub(crate) fn load(dir: &std::path::Path) -> Self {
        let file = dir.join(FILE);
        let list = match fs::read_to_string(&file) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| {
                // Keep the unreadable file for the user instead of overwriting it
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

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<LocalInstance>> {
        self.list.lock().expect("local instances lock poisoned")
    }

    pub(crate) fn snapshot(&self) -> Vec<LocalInstance> {
        self.lock().clone()
    }

    pub(crate) fn get(&self, id: &str) -> Result<LocalInstance, CommandError> {
        self.lock()
            .iter()
            .find(|i| i.id == id)
            .cloned()
            .ok_or_else(|| {
                CommandError::new(
                    ErrorCode::InvalidInput,
                    "QluePrint has no local database with that id.",
                )
            })
    }

    fn write(&self, list: Vec<LocalInstance>) -> Result<(), CommandError> {
        write_json(&self.file, &list).map_err(|e| {
            CommandError::new(
                ErrorCode::SaveFailed,
                format!("Couldn’t save the local database list: {e}"),
            )
        })?;
        *self.lock() = list;
        Ok(())
    }

    /// Adds the instance, or replaces the one with its id.
    pub(crate) fn put(&self, instance: LocalInstance) -> Result<(), CommandError> {
        let mut list = self.snapshot();
        match list.iter_mut().find(|i| i.id == instance.id) {
            Some(slot) => *slot = instance,
            None => list.push(instance),
        }
        self.write(list)
    }

    pub(crate) fn remove(&self, id: &str) -> Result<(), CommandError> {
        let list = self.snapshot().into_iter().filter(|i| i.id != id).collect();
        self.write(list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::types::{Engine, InstanceStatus, Provider, SampleState};

    #[test]
    fn saves_and_reloads_instances_without_secrets() {
        let dir = std::env::temp_dir().join(format!("qc-local-{}", crate::saved::new_id()));
        let store = Store::load(&dir);
        let instance = LocalInstance {
            id: "1a2b".into(),
            name: "qlueprint_demo".into(),
            engine: Engine::Postgres,
            version: "17.11".into(),
            provider: Provider::Docker,
            container_id: Some("abc".into()),
            container_name: Some("qlueprint-postgres-1a2b".into()),
            volume: Some("qlueprint-1a2b".into()),
            data_path: None,
            service: None,
            host: "127.0.0.1".into(),
            port: Some(5433),
            database: "qlueprint_demo".into(),
            user: Some("qlueprint".into()),
            created_at: 1,
            status: InstanceStatus::Running,
            managed: true,
            saved_connection_id: Some("c1".into()),
            sample_data: SampleState::Loaded,
            uninstall: None,
        };
        store.put(instance.clone()).unwrap();
        store
            .put(LocalInstance {
                status: InstanceStatus::Stopped,
                ..instance
            })
            .unwrap();

        let reloaded = Store::load(&dir);
        assert_eq!(reloaded.snapshot().len(), 1);
        assert_eq!(
            reloaded.get("1a2b").unwrap().status,
            InstanceStatus::Stopped
        );
        let text = fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(!text.to_ascii_lowercase().contains("password"));
        reloaded.remove("1a2b").unwrap();
        assert!(Store::load(&dir).snapshot().is_empty());
        let _ = fs::remove_dir_all(dir);
    }
}
