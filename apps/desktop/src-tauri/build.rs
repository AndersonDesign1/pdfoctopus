// SPDX-License-Identifier: AGPL-3.0-or-later
fn main() {
    // The app's own commands (src/lib.rs) are listed so each needs a permission in
    // capabilities/default.json, like the plugins' commands, instead of being open to any window.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "startup_file_name",
            "read_startup_file",
            "timestamp_request",
        ]),
    ))
    .expect("failed to run tauri-build");
}
