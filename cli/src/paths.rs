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
    xdg(xdg_var, xdg_fallback).join("lattice")
}

pub fn cache_dir() -> PathBuf {
    resolve("LATTICE_CACHE_DIR", "XDG_CACHE_HOME", ".cache")
}

pub fn socket_path() -> PathBuf {
    if let Ok(v) = std::env::var("LATTICE_SOCKET") {
        PathBuf::from(v)
    } else {
        cache_dir().join("latticed.sock")
    }
}

pub fn pid_path() -> PathBuf {
    cache_dir().join("latticed.pid")
}
