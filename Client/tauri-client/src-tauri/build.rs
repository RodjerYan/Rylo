use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=../../../Server");

    if cfg!(target_os = "windows") {
        build_server_binary();
    }

    tauri_build::build()
}

fn build_server_binary() {
    let server_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../Server");

    let status = Command::new("go")
        .current_dir(&server_dir)
        .arg("build")
        .arg("-o")
        .arg("chatserver.exe")
        .arg("-ldflags")
        .arg("-s -w -X main.version=1.0.1")
        .arg(".")
        .status()
        .unwrap_or_else(|err| panic!("failed to spawn Go build for bundled server: {err}"));

    if !status.success() {
        panic!("failed to build bundled server binary from {}", server_dir.display());
    }
}
