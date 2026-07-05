use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;

/// Waits for the single browser redirect of the sign-in hand-off on the
/// loopback callback port and returns the request path (with its query).
/// The listener exists only for the one request and then closes.
#[tauri::command]
async fn await_login_callback(port: u16) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let listener = TcpListener::bind(("127.0.0.1", port))
            .map_err(|error| format!("could not listen on 127.0.0.1:{port}: {error}"))?;

        let (mut stream, _) = listener
            .accept()
            .map_err(|error| format!("callback accept failed: {error}"))?;

        let mut reader = BufReader::new(
            stream
                .try_clone()
                .map_err(|error| format!("callback stream failed: {error}"))?,
        );
        let mut request_line = String::new();
        reader
            .read_line(&mut request_line)
            .map_err(|error| format!("callback read failed: {error}"))?;

        let path = request_line
            .split_whitespace()
            .nth(1)
            .unwrap_or("/")
            .to_string();

        let body = "You are logged in. You can close this tab and return to Mod Bots.";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes());

        Ok(path)
    })
    .await
    .map_err(|error| format!("callback task failed: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_upload::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![await_login_callback])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
