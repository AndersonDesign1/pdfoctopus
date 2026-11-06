// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Native layer for the desktop app. Later phases add: native MuPDF (DOCX export),
// the Windows certificate store and smart cards, and Microsoft Office automation.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Native "Save as" dialog. A path the user picks there is added to the fs scope,
        // so the app can write only to files the user chose.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running PDFoctopus");
}
