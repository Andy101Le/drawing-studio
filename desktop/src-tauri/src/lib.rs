//! OMNI-CELL native shell.
//!
//! The web UI (web/app) runs unchanged inside a Tauri 2 window. The shell adds what a
//! browser cannot give: an installer and dock icon, the `.omni` file association (double
//! click opens the project), native file dialogs and direct disk I/O for project files,
//! and OS metadata the UI shows in the status bar. The zero-knowledge contract is kept:
//! `.omni` files are AES-GCM ciphertext produced in the webview; the shell only moves
//! bytes and never sees K_m or K_d.
//!
//! Commands are invoked from TypeScript through `window.__TAURI__.core.invoke`, see
//! web/app/ui/native.ts.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
pub struct FileInfo {
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
}

#[derive(Serialize, Clone)]
pub struct HostInfo {
    pub os: String,
    pub arch: String,
    pub tauri: String,
    pub cpu_threads: usize,
}

/// Read a project file as raw bytes. The webview decrypts; the shell never parses it.
#[tauri::command]
fn read_project(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("read {path}: {e}"))
}

/// Write ciphertext to disk atomically: temp file next to the target, then rename, so a
/// crash mid-write never leaves a truncated project.
#[tauri::command]
fn write_project(path: String, bytes: Vec<u8>) -> Result<FileInfo, String> {
    let target = PathBuf::from(&path);
    let dir = target
        .parent()
        .ok_or_else(|| format!("no parent directory for {path}"))?;
    let tmp = dir.join(format!(
        ".{}.part",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("project.omni")
    ));
    fs::write(&tmp, &bytes).map_err(|e| format!("write temp {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &target).map_err(|e| format!("rename to {path}: {e}"))?;
    let mut h = Sha256::new();
    h.update(&bytes);
    Ok(FileInfo {
        path,
        bytes: bytes.len(),
        sha256: hex::encode(h.finalize()),
    })
}

#[tauri::command]
fn host_info() -> HostInfo {
    HostInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        tauri: tauri::VERSION.to_string(),
        cpu_threads: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
    }
}

/// Files handed to the app at launch (double-clicked `.omni`, or `omni-cell file.omni`).
/// They are emitted to the webview as `open-file` once it is ready; the UI then reads
/// them with `read_project` and decrypts in place.
fn launch_files() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|a| a.to_ascii_lowercase().ends_with(".omni"))
        .collect()
}

#[tauri::command]
fn pending_open_files(app: AppHandle) -> Vec<String> {
    app.state::<PendingFiles>().0.clone()
}

struct PendingFiles(Vec<String>);

pub fn run() {
    let files = launch_files();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingFiles(files.clone()))
        .invoke_handler(tauri::generate_handler![
            read_project,
            write_project,
            host_info,
            pending_open_files
        ])
        .setup(move |app| {
            if !files.is_empty() {
                let handle = app.handle().clone();
                // the webview may not be listening yet; it also pulls `pending_open_files` on boot
                let _ = handle.emit("open-file", files.clone());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OMNI-CELL");
}
