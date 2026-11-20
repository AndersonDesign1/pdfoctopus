// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Native layer for the desktop app: the file it was opened with, and sending timestamp
// requests for signatures (which browsers can't). Later phases add: native MuPDF (DOCX export),
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
    let bytes =
        std::fs::read(&path).map_err(|err| format!("could not read {}: {err}", path.display()))?;
    guard.take();
    Ok(Response::new(bytes))
}

/// The timestamp servers a signature can be timestamped by (PAdES B-T). Only these two can be
/// reached, and only with a timestamp request: the web app asks by name, never by address.
fn timestamp_server_url(server: &str) -> Option<&'static str> {
    match server {
        "digicert" => Some("http://timestamp.digicert.com"),
        "sectigo" => Some("https://timestamp.sectigo.com"),
        _ => None,
    }
}

/// A timestamp request is about 60 bytes (a hash and a nonce); anything big isn't one.
const MAX_TIMESTAMP_REQUEST: usize = 1024;
/// Real timestamp responses are 5 to 10 KB.
const MAX_TIMESTAMP_RESPONSE: u64 = 256 * 1024;

fn post_timestamp_request(url: &str, request: &[u8]) -> Result<Vec<u8>, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(30)))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent
        .post(url)
        .header("Content-Type", "application/timestamp-query")
        .send(request)
        .map_err(|err| err.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    response
        .body_mut()
        .with_config()
        .limit(MAX_TIMESTAMP_RESPONSE)
        .read_to_vec()
        .map_err(|err| err.to_string())
}

/// Send an RFC 3161 timestamp request (made and checked by the web app: it holds only the
/// hash of a signature, never the file) to one of the two timestamp servers, and return the
/// server's answer. Browsers can't do this themselves: the servers don't allow it (CORS).
#[tauri::command]
async fn timestamp_request(server: String, request: Vec<u8>) -> Result<Response, String> {
    let url =
        timestamp_server_url(&server).ok_or_else(|| "unknown timestamp server".to_string())?;
    if request.is_empty() || request.len() > MAX_TIMESTAMP_REQUEST {
        return Err("not a timestamp request".to_string());
    }
    let body = tauri::async_runtime::spawn_blocking(move || post_timestamp_request(url, &request))
        .await
        .map_err(|err| err.to_string())??;
    Ok(Response::new(body))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(StartupFile(Mutex::new(pdf_from_args())))
        // Native "Save as" and folder dialogs. A file or folder the user picks there is added
        // to the fs scope, so the app can write only where the user chose.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            startup_file_name,
            read_startup_file,
            timestamp_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running PDFoctopus");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_two_timestamp_servers() {
        assert_eq!(
            timestamp_server_url("digicert"),
            Some("http://timestamp.digicert.com")
        );
        assert_eq!(
            timestamp_server_url("sectigo"),
            Some("https://timestamp.sectigo.com")
        );
        assert_eq!(timestamp_server_url("https://example.com"), None);
        assert_eq!(timestamp_server_url(""), None);
    }

    /// Reaches the real servers, so it's skipped unless asked for:
    /// cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -- --ignored
    #[test]
    #[ignore]
    fn the_real_servers_answer() {
        // Made with `openssl ts -query -sha256 -cert -no_nonce` (a hash of "hello\n").
        let request = [
            0x30, 0x39, 0x02, 0x01, 0x01, 0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48,
            0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20, 0x58, 0x91, 0xb5, 0xb5,
            0x22, 0xd5, 0xdf, 0x08, 0x6d, 0x0f, 0xf0, 0xb1, 0x10, 0xfb, 0xd9, 0xd2, 0x1b, 0xb4,
            0xfc, 0x71, 0x63, 0xaf, 0x34, 0xd0, 0x82, 0x86, 0xa2, 0xe8, 0x46, 0xf6, 0xbe, 0x03,
            0x01, 0x01, 0xff,
        ];
        for server in ["digicert", "sectigo"] {
            let url = timestamp_server_url(server).unwrap();
            let response = post_timestamp_request(url, &request).unwrap();
            // SEQUENCE { PKIStatusInfo { INTEGER 0 (granted) } ...
            assert_eq!(&response[..1], &[0x30], "{server}");
            assert!(response.len() > 1000, "{server}");
        }
    }
}
