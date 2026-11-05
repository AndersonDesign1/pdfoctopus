// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Native layer for the desktop app. Later phases add: native MuPDF (DOCX export),
// the Windows certificate store and smart cards, and Microsoft Office automation.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running PDFoctopus");
}
