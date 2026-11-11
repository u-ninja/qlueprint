use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(not(dev))]
use tauri::{Url, ipc::CapabilityBuilder};
use tauri_specta::{ErrorHandlingMode, collect_commands, collect_events};

// Fixed so the origin (and the stored auth session) stays the same across launches.
// shortcut: app fails to start if another process holds this port, pick a fallback if that bites.
const LOCALHOST_PORT: u16 = 14200;

/// Where the generated UI types go, relative to src-tauri (the cwd of `tauri dev` and `cargo test`).
const BINDINGS_PATH: &str = "../src/bindings.ts";

mod audit;
mod chrome;
mod db;
mod entra;
mod inspect;
mod local;
mod mssql;
mod plan;
mod query;
mod saved;

/// Every command the UI can call. Adding one here also puts it in src/bindings.ts.
/// New commands also need an entry in build.rs and permissions/app.toml.
fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::new()
        .commands(collect_commands![
            db::list_databases,
            db::connection_databases,
            db::disconnect,
            db::list_schemas,
            db::list_columns,
            inspect::table_details,
            inspect::lookup_rows,
            query::run_query,
            query::apply_edits,
            plan::explain_query,
            entra::entra_sign_in,
            entra::entra_cancel_sign_in,
            saved::list_saved,
            saved::connect_and_save,
            saved::connect_saved,
            saved::forget_saved,
            saved::rename_saved,
            saved::update_saved,
            saved::test_connection,
            audit::list_audit_events,
            audit::verify_audit_log,
            audit::export_audit_log,
            local::docker_status,
            local::discover_local_databases,
            local::local_database_templates,
            local::plan_local_database,
            local::create_local_database,
            local::cancel_provisioning,
            local::start_local_database,
            local::stop_local_database,
            local::restart_local_database,
            local::local_database_logs,
            local::test_local_database,
            local::connect_local_database,
            local::init_sample_data,
            local::remove_local_database,
            local::delete_local_database_data,
            local::list_local_instances,
        ])
        // Provisioning progress for "Create local database"
        .events(collect_events![local::LocalProgress])
        // Rejects with CommandError, so callers keep using try/catch.
        .error_handling(ErrorHandlingMode::Throw)
}

fn export_bindings(builder: &tauri_specta::Builder<tauri::Wry>) {
    builder
        .export(specta_typescript::Typescript::default(), BINDINGS_PATH)
        .expect("failed to export TypeScript bindings");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let specta = specta_builder();
    #[cfg(debug_assertions)]
    export_bindings(&specta);

    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(chrome::menu)
        .on_menu_event(chrome::forward_menu_event);

    let invoke_handler = specta.invoke_handler();
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_oauth::init())
        // Brings back the window's size, position, and maximized or full-screen state from the last run
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Serve the built app over http://localhost: Neon Auth rejects the tauri:// origin
        .plugin(tauri_plugin_localhost::Builder::new(LOCALHOST_PORT).build())
        .setup(move |app| {
            specta.mount_events(app);
            let data_dir = app.path().app_data_dir()?;
            // Opened before any command can run, so the reconnects at launch are recorded too
            app.manage(tauri::async_runtime::block_on(audit::Audit::open(
                &data_dir,
            )));
            app.manage(saved::Saved::load(data_dir.clone()));
            app.manage(local::Local::load(data_dir));

            #[cfg(dev)]
            let url = WebviewUrl::App(std::path::PathBuf::from("/"));

            #[cfg(not(dev))]
            let url = {
                let url: Url = format!("http://localhost:{LOCALHOST_PORT}")
                    .parse()
                    .unwrap();
                app.add_capability(
                    CapabilityBuilder::new("localhost")
                        .remote(url.to_string())
                        .window("main")
                        // Same as capabilities/default.json, which only covers local origins
                        .permission("core:default")
                        .permission("opener:default")
                        .permission("oauth:allow-start")
                        .permission("oauth:allow-cancel")
                        .permission("app-commands")
                        .permission("window-controls"),
                )?;
                WebviewUrl::External(url)
            };

            chrome::title_bar(WebviewWindowBuilder::new(app, "main", url))
                .title("querycraft")
                // First launch only: after that the window-state plugin restores the last size
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .center()
                .build()?;

            Ok(())
        })
        .manage(db::Connections::default())
        .invoke_handler(invoke_handler)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    /// `cargo test` regenerates src/bindings.ts without launching the app;
    /// a diff in git means the TypeScript types were stale.
    #[test]
    fn export_bindings() {
        super::export_bindings(&super::specta_builder());
    }
}
