use std::fs;
use std::process::Command;
use anyhow::{Result, bail};

use crate::DaemonAction;
use crate::paths;

/// Returns (program, extra_args) for running clawketd.
/// Priority: CLAWKET_DAEMON_BIN env > sibling daemon/bin/clawketd.js > PATH "clawketd"
fn clawketd_cmd() -> (String, Vec<String>) {
    // 1. Explicit env var
    if let Ok(bin) = std::env::var("CLAWKET_DAEMON_BIN") {
        let parts: Vec<String> = bin.split_whitespace().map(String::from).collect();
        return (parts[0].clone(), parts[1..].to_vec());
    }

    // 2. Auto-discover: CLI binary location → ../daemon/bin/clawketd.js
    if let Ok(exe) = std::env::current_exe() {
        if let Some(bin_dir) = exe.parent() {
            let clawketd_js = bin_dir.join("..").join("daemon").join("bin").join("clawketd.js");
            if clawketd_js.exists() {
                let canonical = clawketd_js.canonicalize().unwrap_or(clawketd_js);
                return ("node".to_string(), vec![canonical.to_string_lossy().to_string()]);
            }
        }
    }

    // 3. Fallback: PATH
    ("clawketd".to_string(), vec![])
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

fn run_clawketd(subcmd: &str) -> Result<std::process::Output> {
    let (program, extra_args) = clawketd_cmd();
    let output = Command::new(&program)
        .args(&extra_args)
        .arg(subcmd)
        .output();
    match output {
        Ok(out) => Ok(out),
        Err(e) => bail!("failed to run '{program}': {e}\nMake sure clawketd is in your PATH or set CLAWKET_DAEMON_BIN"),
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
            println!("clawketd: already running (pid={pid})");
            return Ok(());
        }
    }
    let out = run_clawketd("start")?;
    print_output(&out);
    if !out.status.success() {
        bail!("clawketd start failed (exit code: {:?})", out.status.code());
    }
    Ok(())
}

fn cmd_stop() -> Result<()> {
    let out = run_clawketd("stop")?;
    print_output(&out);
    Ok(())
}

fn cmd_status() -> Result<()> {
    let out = run_clawketd("status")?;
    print_output(&out);
    if !out.status.success() {
        std::process::exit(1);
    }
    Ok(())
}
