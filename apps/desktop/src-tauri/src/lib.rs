use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
#[cfg(not(dev))]
use tauri::{Url, ipc::CapabilityBuilder};
use tauri_specta::{ErrorHandlingMode, collect_commands, collect_events};

// Fixed so the origin (and the stored auth session) stays the same across launches.
// shortcut: app fails to start if another process holds this port, pick a fallback if that bites.
const LOCALHOST_PORT: u16 = 14200;

/// Where the generated UI types go, relative to src-tauri (the cwd of `tauri dev` and `cargo test`).
/// Passed by start at login: the window stays in the tray until opened.
const HIDDEN_FLAG: &str = "--hidden";

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
mod scheduler;

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
            inspect::routine_definition,
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
            scheduler::list_schedules,
            scheduler::save_schedule,
            scheduler::delete_schedule,
            scheduler::run_schedule_now,
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

/// Brings the main window back from the tray (or behind other windows).
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The tray icon that keeps scheduled queries reachable while the window is hidden.
fn tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("show", "Show QluePrint").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?)
        .build()?;
    let mut tray = TrayIconBuilder::new()
        .tooltip("QluePrint")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
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
        // Checks GitHub's latest release (tauri.conf.json), installs it, then restarts the app
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Start at login (Settings), launching hidden in the tray
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN_FLAG]),
        ))
        // Export data: a Save As dialog, then the chosen file (the dialog adds only that path to the fs scope)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
            app.manage(scheduler::Schedules::load(data_dir.clone()));
            app.manage(local::Local::load(data_dir));
            scheduler::start(app.handle().clone());

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
                        .permission("window-controls")
                        .permission("updater:default")
                        .permission("process:allow-restart")
                        .permission("autostart:allow-enable")
                        .permission("autostart:allow-disable")
                        .permission("autostart:allow-is-enabled"),
                )?;
                WebviewUrl::External(url)
            };

            let window = chrome::title_bar(WebviewWindowBuilder::new(app, "main", url))
                .title("QluePrint")
                // First launch only: after that the window-state plugin restores the last size
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .center()
                // Off so the page's own drag and drop (reordering tabs) works on Windows; the app
                // takes no file drops
                .disable_drag_drop_handler()
                .visible(!std::env::args().any(|a| a == HIDDEN_FLAG))
                .build()?;
            tray(app.handle())?;
            #[cfg(target_os = "macos")]
            chrome::keep_traffic_lights(&window);

            Ok(())
        })
        .manage(db::Connections::default())
        .on_window_event(|window, event| {
            // With a schedule enabled, closing hides the window and the app keeps running: Quit is in the tray
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
                && window.state::<scheduler::Schedules>().any_enabled()
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(invoke_handler)
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // A dock click on macOS with the window hidden
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
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
