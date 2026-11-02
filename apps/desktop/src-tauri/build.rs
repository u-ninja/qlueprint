fn main() {
    // Declaring the app's commands makes Tauri require a capability permission for each one
    // (allow-<command>), the same rule plugin commands follow. See capabilities/default.json.
    let app = tauri_build::AppManifest::new().commands(&["connect", "disconnect", "list_schemas"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app))
        .expect("failed to run tauri-build");
}
