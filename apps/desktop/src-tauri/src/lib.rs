#[cfg(not(dev))]
use tauri::{Manager, Url, ipc::CapabilityBuilder};
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_specta::{ErrorHandlingMode, collect_commands};

// Fixed so the origin (and the stored auth session) stays the same across launches.
// shortcut: app fails to start if another process holds this port, pick a fallback if that bites.
const LOCALHOST_PORT: u16 = 14200;

/// Where the generated UI types go, relative to src-tauri (the cwd of `tauri dev` and `cargo test`).
const BINDINGS_PATH: &str = "../src/bindings.ts";

mod db;
mod query;

/// Every command the UI can call. Adding one here also puts it in src/bindings.ts.
/// New commands also need an entry in build.rs and permissions/app.toml.
fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::new()
        .commands(collect_commands![
            db::connect,
            db::disconnect,
            db::list_schemas,
            query::run_query,
        ])
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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_oauth::init())
        // Serve the built app over http://localhost: Neon Auth rejects the tauri:// origin
        .plugin(tauri_plugin_localhost::Builder::new(LOCALHOST_PORT).build())
        .setup(|app| {
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
                        .permission("app-commands"),
                )?;
                WebviewUrl::External(url)
            };

            WebviewWindowBuilder::new(app, "main", url)
                .title("querycraft")
                .inner_size(800.0, 600.0)
                .build()?;

            Ok(())
        })
        .manage(db::Connections::default())
        .invoke_handler(specta.invoke_handler())
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
