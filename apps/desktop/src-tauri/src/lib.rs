#[cfg(not(dev))]
use tauri::{ipc::CapabilityBuilder, Manager, Url};
use tauri::{WebviewUrl, WebviewWindowBuilder};

// Fixed so the origin (and the stored auth session) stays the same across launches.
// shortcut: app fails to start if another process holds this port, pick a fallback if that bites.
const LOCALHOST_PORT: u16 = 14200;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
                let url: Url = format!("http://localhost:{LOCALHOST_PORT}").parse().unwrap();
                app.add_capability(
                    CapabilityBuilder::new("localhost")
                        .remote(url.to_string())
                        .window("main")
                        // Same as capabilities/default.json, which only covers local origins
                        .permission("core:default")
                        .permission("opener:default")
                        .permission("oauth:allow-start")
                        .permission("oauth:allow-cancel"),
                )?;
                WebviewUrl::External(url)
            };

            WebviewWindowBuilder::new(app, "main", url)
                .title("querycraft")
                .inner_size(800.0, 600.0)
                .build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
