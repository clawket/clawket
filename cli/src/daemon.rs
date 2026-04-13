use std::fs;
use std::process::Command;
use anyhow::{Result, bail};

use crate::DaemonAction;
use crate::paths;

/// Returns (program, extra_args) for running latticed.
/// Priority: LATTICE_DAEMON_BIN env > sibling daemon/bin/latticed.js > PATH "latticed"
fn latticed_cmd() -> (String, Vec<String>) {
    // 1. Explicit env var
    if let Ok(bin) = std::env::var("LATTICE_DAEMON_BIN") {
        let parts: Vec<String> = bin.split_whitespace().map(String::from).collect();
        return (parts[0].clone(), parts[1..].to_vec());
    }

    // 2. Auto-discover: CLI binary location → ../daemon/bin/latticed.js
    if let Ok(exe) = std::env::current_exe() {
        if let Some(bin_dir) = exe.parent() {
            let latticed_js = bin_dir.join("..").join("daemon").join("bin").join("latticed.js");
            if latticed_js.exists() {
                let canonical = latticed_js.canonicalize().unwrap_or(latticed_js);
                return ("node".to_string(), vec![canonical.to_string_lossy().to_string()]);
            }
        }
    }

    // 3. Fallback: PATH
    ("latticed".to_string(), vec![])
}

fn read_pid() -> Option<u32> {
    fs::read_to_string(paths::pid_path())
        .ok()?
        .trim()
        .parse()
        .ok()
}

fn is_running(pid: u32) -> bool {
    // kill -0 으로 프로세스 존재 확인
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

pub async fn run(action: DaemonAction) -> Result<()> {
    match action {
        DaemonAction::Start => cmd_start(),
        DaemonAction::Stop => cmd_stop(),
        DaemonAction::Status => cmd_status(),
        DaemonAction::Restart => {
            cmd_stop()?;
            cmd_start()
        }
    }
}

fn run_latticed(subcmd: &str) -> Result<std::process::Output> {
    let (program, extra_args) = latticed_cmd();
    let output = Command::new(&program)
        .args(&extra_args)
        .arg(subcmd)
        .output();
    match output {
        Ok(out) => Ok(out),
        Err(e) => bail!("failed to run '{program}': {e}\nMake sure latticed is in your PATH or set LATTICE_DAEMON_BIN"),
    }
}

fn print_output(out: &std::process::Output) {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stdout.is_empty() { print!("{stdout}"); }
    if !stderr.is_empty() { eprint!("{stderr}"); }
}

fn cmd_start() -> Result<()> {
    if let Some(pid) = read_pid() {
        if is_running(pid) {
            println!("latticed: already running (pid={pid})");
            return Ok(());
        }
    }
    let out = run_latticed("start")?;
    print_output(&out);
    if !out.status.success() {
        bail!("latticed start failed (exit code: {:?})", out.status.code());
    }
    Ok(())
}

fn cmd_stop() -> Result<()> {
    let out = run_latticed("stop")?;
    print_output(&out);
    Ok(())
}

fn cmd_status() -> Result<()> {
    let out = run_latticed("status")?;
    print_output(&out);
    if !out.status.success() {
        std::process::exit(1);
    }
    Ok(())
}
