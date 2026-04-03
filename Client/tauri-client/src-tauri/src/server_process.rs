use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
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
    let resource_dir = app.path().resource_dir().ok();
    let current_exe = std::env::current_exe().ok();
    let dev_server_binary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../Server")
        .join(SERVER_BINARY_NAME);

    resolve_server_binary_from_paths(
        resource_dir.as_deref(),
        current_exe.as_deref(),
        &dev_server_binary,
    )
}

fn resolve_server_binary_from_paths(
    resource_dir: Option<&Path>,
    current_exe: Option<&Path>,
    dev_server_binary: &Path,
) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(dir) = resource_dir {
        append_server_binary_candidates(&mut candidates, dir);
    }

    if let Some(exe) = current_exe {
        if let Some(parent) = exe.parent() {
            append_server_binary_candidates(&mut candidates, parent);
        }
    }

    push_unique_candidate(&mut candidates, dev_server_binary.to_path_buf());

    candidates.into_iter().find(|path| path.exists())
}

fn append_server_binary_candidates(candidates: &mut Vec<PathBuf>, base_dir: &Path) {
    let mut current_dir = Some(base_dir.to_path_buf());

    for _ in 0..=4 {
        let Some(dir) = current_dir.take() else {
            break;
        };

        push_unique_candidate(candidates, dir.join(SERVER_BINARY_NAME));
        push_unique_candidate(candidates, dir.join("Server").join(SERVER_BINARY_NAME));

        current_dir = Some(dir.join("_up_"));
    }
}

fn push_unique_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if !candidates.iter().any(|candidate| candidate == &path) {
        candidates.push(path);
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_server_binary_from_paths;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("rylo-server-process-{label}-{unique}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent dirs");
        }
        fs::write(path, b"").expect("write placeholder file");
    }

    #[test]
    fn resolves_bundled_server_from_server_subdirectory() {
        let root = make_temp_dir("server-subdir");
        let resource_dir = root.join("resources");
        let server_binary = resource_dir.join("Server").join("chatserver.exe");
        touch(&server_binary);

        let resolved =
            resolve_server_binary_from_paths(Some(&resource_dir), None, Path::new("missing"));

        assert_eq!(resolved.as_deref(), Some(server_binary.as_path()));

        fs::remove_dir_all(root).expect("cleanup temp dir");
    }

    #[test]
    fn resolves_server_from_nested_updater_directory() {
        let root = make_temp_dir("nested-updater");
        let exe_dir = root.join("install");
        let current_exe = exe_dir.join("rylo-client.exe");
        let server_binary = exe_dir
            .join("_up_")
            .join("_up_")
            .join("_up_")
            .join("Server")
            .join("chatserver.exe");
        touch(&current_exe);
        touch(&server_binary);

        let resolved =
            resolve_server_binary_from_paths(None, Some(&current_exe), Path::new("missing"));

        assert_eq!(resolved.as_deref(), Some(server_binary.as_path()));

        fs::remove_dir_all(root).expect("cleanup temp dir");
    }
}
