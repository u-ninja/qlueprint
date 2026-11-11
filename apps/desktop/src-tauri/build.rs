fn main() {
    // Declaring the app's commands makes Tauri require a capability permission for each one
    // (allow-<command>), the same rule plugin commands follow. The `app-commands` set in
    // permissions/app.toml grants them all; add each new command there too.
    let app = tauri_build::AppManifest::new().commands(&[
        "list_databases",
        "connection_databases",
        "disconnect",
        "list_schemas",
        "list_columns",
        "table_details",
        "lookup_rows",
        "run_query",
        "apply_edits",
        "explain_query",
        "entra_sign_in",
        "entra_cancel_sign_in",
        "list_saved",
        "connect_and_save",
        "connect_saved",
        "forget_saved",
        "rename_saved",
        "update_saved",
        "test_connection",
        "list_audit_events",
        "verify_audit_log",
        "export_audit_log",
        "docker_status",
        "discover_local_databases",
        "local_database_templates",
        "plan_local_database",
        "create_local_database",
        "cancel_provisioning",
        "start_local_database",
        "stop_local_database",
        "restart_local_database",
        "local_database_logs",
        "test_local_database",
        "connect_local_database",
        "init_sample_data",
        "remove_local_database",
        "delete_local_database_data",
        "list_local_instances",
    ]);

    // Tauri embeds its Windows manifest (Common Controls v6) only into the app binary, so test
    // binaries that link Tauri crash on start with STATUS_ENTRYPOINT_NOT_FOUND. On MSVC, embed
    // the same manifest into every binary instead: rustc-link-arg also reaches `cargo test`.
    // windows-app-manifest.xml is a copy of tauri-build's own. shortcut: drop this once
    // tauri-build can call tauri-winres' compile_for_everything() itself.
    let windows = if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed=windows-app-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        tauri_build::WindowsAttributes::new_without_app_manifest()
    } else {
        tauri_build::WindowsAttributes::new()
    };

    let attributes = tauri_build::Attributes::new()
        .app_manifest(app)
        .windows_attributes(windows);
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
