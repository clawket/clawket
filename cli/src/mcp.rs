use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;
use std::process::Command;

/// Run the @clawket/mcp stdio server.
/// stdin/stdout/stderr are inherited so MCP JSON-RPC flows directly to/from the caller.
/// Exits with the child process's exit code.
pub fn run() -> Result<()> {
    let script = resolve_mcp_script()?;
    let status = Command::new("node")
        .arg(&script)
        .status()
        .with_context(|| format!(
            "Failed to spawn node for MCP server at {}. Is Node.js installed and on PATH?",
            script.display()
        ))?;
    std::process::exit(status.code().unwrap_or(1));
}

/// Resolution order:
/// 1. `CLAWKET_MCP_PATH` env var → used verbatim (development override)
/// 2. `<exe_dir>/../mcp/dist/index.js` → production install layout
///    (sibling of `bin/` in plugin cache: `{version}/bin/clawket`, `{version}/mcp/dist/index.js`)
fn resolve_mcp_script() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("CLAWKET_MCP_PATH") {
        let path = PathBuf::from(p);
        if !path.exists() {
            return Err(anyhow!(
                "CLAWKET_MCP_PATH points to a non-existent file: {}",
                path.display()
            ));
        }
        return Ok(path);
    }

    let exe = std::env::current_exe().context("failed to resolve current executable")?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| anyhow!("executable has no parent directory: {}", exe.display()))?;
    if let Some(install_root) = exe_dir.parent() {
        let candidate = install_root.join("mcp").join("dist").join("index.js");
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(anyhow!(
        "Could not locate clawket-mcp. Set CLAWKET_MCP_PATH to the absolute path of \
         @clawket/mcp's dist/index.js, or install clawket with the bundled MCP module."
    ))
}
