fn main() {
    // Only these commands are callable from the web view; everything else (including plugin commands) must be granted in capabilities/.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "bridge_info",
            "pick_folder",
            "log_event",
            "keychain_get",
            "keychain_set",
            "keychain_delete",
            "keychain_names",
            "reveal_logs",
        ])),
    )
    .expect("failed to run tauri-build");
}
