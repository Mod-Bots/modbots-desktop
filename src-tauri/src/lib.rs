use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

#[cfg(windows)]
use tauri::Manager;
#[cfg(windows)]
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ProcessFailedEventArgs, COREWEBVIEW2_PROCESS_FAILED_KIND,
    },
    ProcessFailedEventHandler,
};

#[cfg(windows)]
static WEBVIEW_RECOVERY_STARTED: AtomicBool = AtomicBool::new(false);

struct PendingLoginCallback {
    cancel: mpsc::Sender<()>,
    done: mpsc::Receiver<()>,
}

#[derive(Default)]
struct LoginCallbackState {
    pending: Mutex<Option<PendingLoginCallback>>,
}

/// Waits for the single browser redirect of the sign-in hand-off on the
/// loopback callback port and returns the request path (with its query).
/// The listener exists only for the one request and then closes.
#[tauri::command]
async fn await_login_callback(
    port: u16,
    state: tauri::State<'_, LoginCallbackState>,
) -> Result<String, String> {
    let (cancel_tx, cancel_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();

    {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "login callback state is unavailable".to_string())?;

        if pending.is_some() {
            return Err("a browser log-in callback is already active".to_string());
        }

        *pending = Some(PendingLoginCallback {
            cancel: cancel_tx,
            done: done_rx,
        });
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
        let listener = TcpListener::bind(("127.0.0.1", port))
            .map_err(|error| format!("could not listen on 127.0.0.1:{port}: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("callback listener setup failed: {error}"))?;

        loop {
            if cancel_rx.try_recv().is_ok() {
                let _ = done_tx.send(());
                return Err("The Browser log-in was canceled.".to_string());
            }

            match listener.accept() {
                Ok((mut stream, _)) => {
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
                    let _ = done_tx.send(());

                    return Ok(path);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(error) => {
                    let _ = done_tx.send(());
                    return Err(format!("callback accept failed: {error}"));
                }
            }
        }
    })
    .await
    .map_err(|error| format!("callback task failed: {error}"))?;

    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "login callback state is unavailable".to_string())?;
    *pending = None;

    result
}

#[tauri::command]
fn cancel_login_callback(state: tauri::State<'_, LoginCallbackState>) -> Result<(), String> {
    let pending = {
        let mut active = state
            .pending
            .lock()
            .map_err(|_| "login callback state is unavailable".to_string())?;
        active.take()
    };

    if let Some(pending) = pending {
        let _ = pending.cancel.send(());
        let _ = pending.done.recv_timeout(Duration::from_secs(2));
    }

    Ok(())
}

#[cfg(windows)]
fn webview_process_failed_kind(args: Option<ICoreWebView2ProcessFailedEventArgs>) -> i32 {
    let Some(args) = args else {
        return -1;
    };

    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(0);
    match unsafe { args.ProcessFailedKind(&mut kind) } {
        Ok(()) => kind.0,
        Err(_) => -1,
    }
}

#[cfg(windows)]
fn attach_webview_process_recovery(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("WebView2 recovery was not attached: main window was not found.");
        return;
    };

    let app_handle = app.handle().clone();
    let recovery_window = window.clone();

    if let Err(error) = window.with_webview(move |webview| {
        let app_handle = app_handle.clone();
        let recovery_window = recovery_window.clone();
        let controller = webview.controller();
        let core_webview = match unsafe { controller.CoreWebView2() } {
            Ok(core_webview) => core_webview,
            Err(error) => {
                eprintln!("WebView2 recovery was not attached: {error}");
                return;
            }
        };

        let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
            let kind = webview_process_failed_kind(args);
            eprintln!("WebView2 process failed, restarting Mod Bots. kind={kind}");

            if !WEBVIEW_RECOVERY_STARTED.swap(true, Ordering::SeqCst) {
                let _ = recovery_window.hide();
                app_handle.request_restart();
            }

            Ok(())
        }));

        let mut token = 0;
        if let Err(error) = unsafe { core_webview.add_ProcessFailed(&handler, &mut token) } {
            eprintln!("WebView2 recovery was not attached: {error}");
        }
    }) {
        eprintln!("WebView2 recovery was not attached: {error}");
    }
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
        .manage(LoginCallbackState::default())
        .setup(|app| {
            #[cfg(windows)]
            attach_webview_process_recovery(app);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            await_login_callback,
            cancel_login_callback
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
