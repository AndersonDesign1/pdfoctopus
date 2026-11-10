// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Native layer for the desktop app. Later phases add: native MuPDF (DOCX export),
// the Windows certificate store and smart cards, and Microsoft Office automation.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::ipc::Response;
use tauri::State;

/// The PDF the app was launched with ("Open with" or double-clicking a file), if any.
/// It is handed to the web app once, and only that one file can be read this way.
struct StartupFile(Mutex<Option<PathBuf>>);

fn pdf_from_args() -> Option<PathBuf> {
    std::env::args_os().skip(1).map(PathBuf::from).find(|path| {
        path.is_file()
            && path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
    })
}

/// The file name of the PDF the app was opened with, without reading it.
#[tauri::command]
fn startup_file_name(state: State<'_, StartupFile>) -> Option<String> {
    let guard = state.0.lock().ok()?;
    guard
        .as_ref()?
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
}

/// Read the PDF the app was opened with. Once it has been read successfully, later calls
/// return an error; a failed read can be retried.
#[tauri::command]
fn read_startup_file(state: State<'_, StartupFile>) -> Result<Response, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    let path = guard
        .as_ref()
        .ok_or_else(|| "no file to open".to_string())?
        .clone();
    let bytes = std::fs::read(&path)
        .map_err(|err| format!("could not read {}: {err}", path.display()))?;
    guard.take();
    Ok(Response::new(bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(StartupFile(Mutex::new(pdf_from_args())))
        // Native "Save as" and folder dialogs. A file or folder the user picks there is added
        // to the fs scope, so the app can write only where the user chose.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![startup_file_name, read_startup_file])
        .run(tauri::generate_context!())
        .expect("error while running PDFoctopus");
}
