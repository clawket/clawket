use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Result, bail};
use serde_json::{Value, json};

use crate::{client, daemon, paths};
use crate::DaemonAction;

fn codex_bin() -> String {
    std::env::var("CODEX_BIN").unwrap_or_else(|_| "codex".to_string())
}

const MARKETPLACE_NAME: &str = "clawket-local";
const PLUGIN_NAME: &str = "clawket";
const PLUGIN_KEY: &str = "clawket@clawket-local";

fn session_file() -> PathBuf {
    paths::codex_dir().join("session.json")
}

fn prompt_file() -> PathBuf {
    paths::codex_dir().join("session-context.md")
}

fn session_id() -> String {
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    format!("codex-{millis}-{}", std::process::id())
}

fn iso8601_now_utc() -> String {
    use std::fmt::Write as _;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let tm = chrono_like_gmtime(now as i64);
    let mut out = String::with_capacity(20);
    let _ = write!(
        out,
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        tm.year, tm.month, tm.day, tm.hour, tm.minute, tm.second
    );
    out
}

struct GmTime {
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
}

fn chrono_like_gmtime(timestamp: i64) -> GmTime {
    let days = timestamp.div_euclid(86_400);
    let secs_of_day = timestamp.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    GmTime {
        year,
        month,
        day,
        hour: (secs_of_day / 3600) as u32,
        minute: ((secs_of_day % 3600) / 60) as u32,
        second: (secs_of_day % 60) as u32,
    }
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year as i32, m as u32, d as u32)
}

fn codex_user_config() -> PathBuf {
    paths::codex_user_config_path()
}

fn installed_plugin_root() -> PathBuf {
    paths::codex_home()
        .join("plugins")
        .join("cache")
        .join(MARKETPLACE_NAME)
        .join(PLUGIN_NAME)
        .join("local")
}

fn root_file(rel: &str) -> Option<PathBuf> {
    paths::project_root().map(|root| root.join(rel))
}

fn read_prompt(rel: &str) -> String {
    root_file(rel)
        .and_then(|file| fs::read_to_string(file).ok())
        .unwrap_or_default()
}

fn section_range(lines: &[String], header: &str) -> Option<(usize, usize)> {
    let start = lines.iter().position(|line| line.trim() == header)?;
    let mut end = lines.len();
    for (idx, line) in lines.iter().enumerate().skip(start + 1) {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            end = idx;
            break;
        }
    }
    Some((start, end))
}

fn upsert_section(lines: &mut Vec<String>, header: &str, kv_lines: &[String]) {
    if let Some((start, mut end)) = section_range(lines, header) {
        for kv_line in kv_lines {
            let key = kv_line.split('=').next().unwrap_or("").trim();
            if let Some(pos) = (start + 1..end).find(|idx| {
                let trimmed = lines[*idx].trim();
                trimmed.starts_with(&format!("{key} =")) || trimmed == key
            }) {
                lines[pos] = kv_line.clone();
            } else {
                lines.insert(end, kv_line.clone());
                end += 1;
            }
        }
        return;
    }

    if !lines.is_empty() && !lines.last().map(|line| line.trim().is_empty()).unwrap_or(false) {
        lines.push(String::new());
    }
    lines.push(header.to_string());
    lines.extend(kv_lines.iter().cloned());
}

fn remove_section(lines: &mut Vec<String>, header: &str) {
    if let Some((start, mut end)) = section_range(lines, header) {
        while end < lines.len() && lines[end].trim().is_empty() {
            end += 1;
        }
        lines.drain(start..end);
        while lines.first().map(|line| line.trim().is_empty()).unwrap_or(false) {
            lines.remove(0);
        }
    }
}

fn read_user_config_lines() -> Result<Vec<String>> {
    let path = codex_user_config();
    let content = if path.exists() {
        fs::read_to_string(path)?
    } else {
        String::new()
    };
    Ok(content.lines().map(|line| line.to_string()).collect())
}

fn write_user_config_lines(lines: &[String]) -> Result<()> {
    let path = codex_user_config();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut content = lines.join("\n");
    if !content.is_empty() {
        content.push('\n');
    }
    fs::write(path, content)?;
    Ok(())
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else if file_type.is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn install_plugin_cache(root: &std::path::Path) -> Result<PathBuf> {
    let src = root.join("plugins").join(PLUGIN_NAME);
    let dst = installed_plugin_root();
    if dst.exists() {
        fs::remove_dir_all(&dst)?;
    }
    copy_dir_all(&src, &dst)?;
    fs::write(dst.join(".clawket-root"), root.to_string_lossy().as_ref())?;
    Ok(dst)
}

fn installation_state() -> serde_json::Value {
    let root = paths::project_root();
    let config_path = codex_user_config();
    let config = fs::read_to_string(&config_path).unwrap_or_default();
    let root_str = root
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();

    json!({
        "codex_home": paths::codex_home(),
        "user_config_path": config_path,
        "project_root": root,
        "hook_feature_enabled": config.contains("[features]") && config.contains("codex_hooks = true"),
        "marketplace_registered": config.contains(&format!("[marketplaces.{MARKETPLACE_NAME}]"))
            && !root_str.is_empty()
            && config.contains(&format!("source = \"{root_str}\"")),
        "plugin_enabled": config.contains(&format!("[plugins.\"{PLUGIN_KEY}\"]"))
            && config.contains("enabled = true"),
        "plugin_cached": installed_plugin_root().join(".codex-plugin").join("plugin.json").exists(),
    })
}

pub fn install() -> Result<serde_json::Value> {
    let root = paths::project_root().ok_or_else(|| anyhow::anyhow!("failed to locate Clawket project root"))?;
    let root_str = root.to_string_lossy().to_string();
    let mut lines = read_user_config_lines()?;

    upsert_section(&mut lines, "[features]", &[
        String::from("plugins = true"),
        String::from("codex_hooks = true"),
    ]);
    upsert_section(&mut lines, &format!("[marketplaces.{MARKETPLACE_NAME}]"), &[
        format!("last_updated = \"{}\"", iso8601_now_utc()),
        String::from("source_type = \"local\""),
        format!("source = \"{root_str}\""),
    ]);
    upsert_section(&mut lines, &format!("[plugins.\"{PLUGIN_KEY}\"]"), &[String::from("enabled = true")]);

    write_user_config_lines(&lines)?;
    let cache_root = install_plugin_cache(&root)?;

    Ok(json!({
        "runtime": "codex",
        "installed": true,
        "project_root": root,
        "user_config_path": codex_user_config(),
        "marketplace": MARKETPLACE_NAME,
        "plugin": PLUGIN_KEY,
        "plugin_cache_root": cache_root,
    }))
}

pub fn uninstall() -> Result<serde_json::Value> {
    let mut lines = read_user_config_lines()?;
    remove_section(&mut lines, &format!("[marketplaces.{MARKETPLACE_NAME}]"));
    remove_section(&mut lines, &format!("[plugins.\"{PLUGIN_KEY}\"]"));
    write_user_config_lines(&lines)?;
    let cache_root = installed_plugin_root();
    if cache_root.exists() {
        fs::remove_dir_all(&cache_root)?;
    }

    Ok(json!({
        "runtime": "codex",
        "installed": false,
        "user_config_path": codex_user_config(),
        "marketplace": MARKETPLACE_NAME,
        "plugin": PLUGIN_KEY,
        "plugin_cache_root": cache_root,
    }))
}

async fn query_dashboard(c: &client::HttpClient, cwd: &str) -> Result<String> {
    let qs = format!("?cwd={}&show=active", urlencoding(cwd));
    let val = client::get(c, &format!("/dashboard{qs}")).await?;
    Ok(val.get("context").and_then(|v| v.as_str()).unwrap_or("").to_string())
}

fn urlencoding(value: &str) -> String {
    value
        .bytes()
        .flat_map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => vec![b as char],
            _ => format!("%{b:02X}").chars().collect(),
        })
        .collect()
}

fn compose_bootstrap(cwd: &str, context: &str) -> String {
    let shared = read_prompt("prompts/shared/rules.md");
    let runtime = read_prompt("prompts/codex/runtime.md");
    let context_block = if context.trim().is_empty() {
        format!(
            "# Clawket\n\nNo project is registered for `{cwd}`.\nRegister one with:\n\n`clawket project create \"<name>\" --cwd \"{cwd}\"`"
        )
    } else {
        format!("# Active Clawket Context\n\n{context}")
    };

    [context_block, shared, runtime]
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

async fn finish_open_runs(c: &client::HttpClient, session_id: &str) -> Result<()> {
    let qs = format!("?session_id={}", urlencoding(session_id));
    let runs = client::get(c, &format!("/runs{qs}")).await?;
    let arr = runs.as_array().cloned().unwrap_or_default();
    for run in arr {
        if run.get("ended_at").and_then(|v| v.as_i64()).is_none() {
            if let Some(id) = run.get("id").and_then(|v| v.as_str()) {
                client::request(c, "POST", &format!("/runs/{id}/finish"), Some(json!({
                    "result": "session_ended",
                    "notes": "Auto-closed by Codex wrapper"
                }))).await?;
            }
        }
    }
    Ok(())
}

async fn current_active_task(c: &client::HttpClient) -> Result<Option<Value>> {
    let val = client::get(c, "/tasks?status=in_progress").await?;
    Ok(val.as_array().and_then(|arr| arr.first()).cloned())
}

pub async fn launch() -> Result<()> {
    fs::create_dir_all(paths::codex_dir())?;
    daemon::run(DaemonAction::Start).await?;

    let cwd = std::env::current_dir()?.to_string_lossy().to_string();
    let c = client::make_client();
    let context = query_dashboard(&c, &cwd).await?;
    let prompt = compose_bootstrap(&cwd, &context);
    let session_id = session_id();

    let task = current_active_task(&c).await?;
    if let Some(task) = task.as_ref() {
        if let Some(task_id) = task.get("id").and_then(|v| v.as_str()) {
            client::request(&c, "POST", "/runs", Some(json!({
                "task_id": task_id,
                "session_id": session_id,
                "agent": "main"
            }))).await?;
        }
    }

    fs::write(prompt_file(), &prompt)?;
    fs::write(session_file(), serde_json::to_string_pretty(&json!({
        "runtime": "codex",
        "session_id": session_id,
        "cwd": cwd,
        "active_task_id": task.as_ref().and_then(|t| t.get("id")).and_then(|v| v.as_str()),
        "managed": true,
        "capabilities": {
            "session_start_context": true,
            "per_turn_context": false,
            "hard_pre_mutation_block": false,
            "activity_stream_capture": false,
            "subagent_lifecycle_hook": false,
            "plan_mode_bridge": false,
            "session_stop_hook": true
        }
    }))?)?;

    eprintln!("[clawket] launching Codex with Clawket bootstrap context");
    eprintln!("[clawket] session: {session_id}");

    let status = Command::new(codex_bin())
        .arg(&prompt)
        .env("CLAWKET_RUNTIME", "codex")
        .env("CLAWKET_SESSION_ID", &session_id)
        .env("CLAWKET_CODEX_SESSION_FILE", session_file())
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()?;

    finish_open_runs(&c, &session_id).await?;

    if !status.success() {
        bail!("codex exited with status {:?}", status.code());
    }
    Ok(())
}

pub fn status() -> Result<serde_json::Value> {
    let file = session_file();
    if !file.exists() {
        return Ok(json!({
            "runtime": "codex",
            "active": false,
            "message": "No Codex wrapper session state found"
        }));
    }
    let val: serde_json::Value = serde_json::from_slice(&fs::read(file)?)?;
    Ok(json!({
        "runtime": "codex",
        "active": true,
        "session": val,
        "prompt_file": prompt_file(),
    }))
}

pub fn doctor() -> serde_json::Value {
    let state = installation_state();
    let root = paths::project_root();
    let codex_version = std::process::Command::new(codex_bin())
        .arg("--version")
        .output()
        .ok()
        .and_then(|out| if out.status.success() {
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            None
        });

    json!({
        "runtime": "codex",
        "ok": codex_version.is_some()
            && state.get("hook_feature_enabled").and_then(|v| v.as_bool()).unwrap_or(false)
            && state.get("marketplace_registered").and_then(|v| v.as_bool()).unwrap_or(false)
            && state.get("plugin_enabled").and_then(|v| v.as_bool()).unwrap_or(false),
        "codex_binary": std::env::var("CODEX_BIN").unwrap_or_else(|_| "codex".to_string()),
        "codex_version": codex_version,
        "wrapper_state_dir": paths::codex_dir(),
        "user_config": state,
        "marketplace_manifest_exists": root.as_ref().map(|r| r.join(".agents/plugins/marketplace.json").exists()).unwrap_or(false),
        "plugin_manifest_exists": root.as_ref().map(|r| r.join("plugins/clawket/.codex-plugin/plugin.json").exists()).unwrap_or(false),
        "plugin_hooks_exists": root.as_ref().map(|r| r.join("plugins/clawket/hooks.json").exists()).unwrap_or(false),
        "plugin_runner_exists": root.as_ref().map(|r| r.join("plugins/clawket/scripts/run-hook.cjs").exists()).unwrap_or(false),
        "shared_adapter_exists": root.as_ref().map(|r| r.join("adapters/shared/codex-hooks.cjs").exists()).unwrap_or(false),
        "runtime_prompt_exists": root.as_ref().map(|r| r.join("prompts/codex/runtime.md").exists()).unwrap_or(false),
    })
}

pub async fn stop() -> Result<serde_json::Value> {
    let status = status()?;
    if !status.get("active").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Ok(status);
    }
    let session = status.get("session").cloned().unwrap_or_else(|| json!({}));
    let session_id = session.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
    if !session_id.is_empty() {
        let c = client::make_client();
        finish_open_runs(&c, session_id).await?;
    }
    Ok(json!({
        "runtime": "codex",
        "stopped": true,
        "session_id": session_id,
    }))
}
