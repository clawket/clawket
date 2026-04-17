use std::path::PathBuf;

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").expect("HOME not set"))
}

fn xdg(env_name: &str, fallback: &str) -> PathBuf {
    if let Ok(v) = std::env::var(env_name) {
        PathBuf::from(v)
    } else {
        home_dir().join(fallback)
    }
}

fn resolve(override_env: &str, xdg_var: &str, xdg_fallback: &str) -> PathBuf {
    if let Ok(v) = std::env::var(override_env) {
        return PathBuf::from(v);
    }
    xdg(xdg_var, xdg_fallback).join("clawket")
}

pub fn cache_dir() -> PathBuf {
    resolve("CLAWKET_CACHE_DIR", "XDG_CACHE_HOME", ".cache")
}

pub fn data_dir() -> PathBuf {
    resolve("CLAWKET_DATA_DIR", "XDG_DATA_HOME", ".local/share")
}

pub fn config_dir() -> PathBuf {
    resolve("CLAWKET_CONFIG_DIR", "XDG_CONFIG_HOME", ".config")
}

pub fn state_dir() -> PathBuf {
    resolve("CLAWKET_STATE_DIR", "XDG_STATE_HOME", ".local/state")
}

pub fn socket_path() -> PathBuf {
    if let Ok(v) = std::env::var("CLAWKET_SOCKET") {
        PathBuf::from(v)
    } else {
        cache_dir().join("clawketd.sock")
    }
}

pub fn pid_path() -> PathBuf {
    cache_dir().join("clawketd.pid")
}

pub fn codex_dir() -> PathBuf {
    cache_dir().join("codex")
}

pub fn codex_home() -> PathBuf {
    if let Ok(v) = std::env::var("CODEX_HOME") {
        PathBuf::from(v)
    } else {
        home_dir().join(".codex")
    }
}

pub fn codex_user_config_path() -> PathBuf {
    codex_home().join("config.toml")
}

pub fn project_root() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("CLAWKET_ROOT") {
        return Some(PathBuf::from(v));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(bin_dir) = exe.parent() {
            let candidate = bin_dir.join("..");
            if candidate.join("prompts").exists() {
                return Some(candidate);
            }
            let candidate = bin_dir.join("..").join("..");
            if candidate.join("prompts").exists() {
                return Some(candidate);
            }
        }
    }

    let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    if manifest_root.join("prompts").exists() {
        return Some(manifest_root);
    }

    std::env::current_dir()
        .ok()
        .filter(|cwd| cwd.join("prompts").exists())
}
