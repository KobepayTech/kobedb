// KobeDB Studio — Tauri 2 desktop shell.
// Boots the KobeDB + KobeDeploy server (Node) and opens the Studio dashboard in a
// native webview. The server is killed when the app exits. Inspired by Terax's
// lightweight Tauri approach (~10MB binary vs ~100MB Electron).
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct ServerProc(Mutex<Option<Child>>);

const STUDIO_URL: &str = "http://localhost:8000/studio/";

/// Locate the built server entry: an explicit override, else the sibling package.
fn server_entry() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("KOBEDB_SERVER_ENTRY") {
        let pb = std::path::PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../server/dist/index.js");
    if dev.exists() {
        return dev.canonicalize().ok();
    }
    None
}

fn spawn_server() -> Option<Child> {
    let entry = server_entry()?;
    let db = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://kobedb:kobedb@localhost:5432/kobedb".to_string());
    Command::new("node")
        .arg(&entry)
        .env("PORT", "8000")
        .env("DATABASE_URL", db)
        .spawn()
        .ok()
}

fn port_open() -> bool {
    match "127.0.0.1:8000".parse() {
        Ok(addr) => std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok(),
        Err(_) => false,
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Best-effort: start the bundled server if we can find it.
            let child = spawn_server();
            app.manage(ServerProc(Mutex::new(child)));

            // Wait for the server to accept connections, then open the Studio window.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for _ in 0..120 {
                    if port_open() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                if let Ok(url) = tauri::Url::parse(STUDIO_URL) {
                    let _ = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                        .title("KobeDB Studio")
                        .inner_size(1320.0, 880.0)
                        .build();
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the KobeDB Studio app")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<ServerProc>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.as_mut() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
