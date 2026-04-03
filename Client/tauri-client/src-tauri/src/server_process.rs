use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const DEFAULT_SERVER_ADDR: &str = "127.0.0.1:8443";
const SERVER_BINARY_NAME: &str = "chatserver.exe";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
pub struct ServerProcessState {
    child: Mutex<Option<Child>>,
}

impl Drop for ServerProcessState {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
            }
            guard.take();
        }
    }
}

pub fn ensure_server_running<R: Runtime>(app: &AppHandle<R>, state: &ServerProcessState) {
    if is_server_listening(DEFAULT_SERVER_ADDR) {
        log::info!("local Rylo server already listening on {DEFAULT_SERVER_ADDR}");
        return;
    }

    let server_binary = match resolve_server_binary(app) {
        Some(path) => path,
        None => {
            log::error!("unable to locate bundled Rylo server binary");
            return;
        }
    };

    let workdir = match prepare_server_workdir(app) {
        Ok(path) => path,
        Err(err) => {
            log::error!("failed to prepare local server workdir: {err}");
            return;
        }
    };

    let mut guard = match state.child.lock() {
        Ok(guard) => guard,
        Err(err) => {
            log::error!("failed to lock local server process state: {err}");
            return;
        }
    };

    if guard.is_some() {
        return;
    }

    let mut command = Command::new(&server_binary);
    command
        .current_dir(&workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    match command.spawn() {
        Ok(child) => {
            log::info!(
                "started local Rylo server from {} with workdir {}",
                server_binary.display(),
                workdir.display()
            );
            *guard = Some(child);
        }
        Err(err) => {
            log::error!(
                "failed to spawn local Rylo server from {}: {}",
                server_binary.display(),
                err
            );
        }
    }
}

fn is_server_listening(addr: &str) -> bool {
    let socket_addr: SocketAddr = match addr.parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };

    TcpStream::connect_timeout(&socket_addr, Duration::from_millis(500)).is_ok()
}

fn prepare_server_workdir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("app_data_dir: {err}"))?;
    let server_dir = base_dir.join("server");

    std::fs::create_dir_all(&server_dir)
        .map_err(|err| format!("create_dir_all {}: {err}", server_dir.display()))?;

    Ok(server_dir)
}

fn resolve_server_binary<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(SERVER_BINARY_NAME));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join(SERVER_BINARY_NAME));
        }
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../Server")
            .join(SERVER_BINARY_NAME),
    );

    candidates.into_iter().find(|path| path.exists())
}
