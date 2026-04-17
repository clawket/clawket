use serde_json::json;

use crate::codex;
use crate::paths;

#[derive(Clone, Copy)]
pub enum RuntimeName {
    Claude,
    Codex,
}

pub fn list_runtimes() -> serde_json::Value {
    json!([
        {
            "name": "claude",
            "kind": "plugin",
            "supports": {
                "session_start_context": true,
                "per_turn_context": true,
                "hard_pre_mutation_block": true,
                "activity_stream_capture": true,
                "subagent_lifecycle_hook": true,
                "plan_mode_bridge": true,
                "session_stop_hook": true
            }
        },
        {
            "name": "codex",
            "kind": "user-installed plugin",
            "supports": {
                "session_start_context": true,
                "per_turn_context": true,
                "hard_pre_mutation_block": true,
                "activity_stream_capture": false,
                "subagent_lifecycle_hook": false,
                "plan_mode_bridge": false,
                "session_stop_hook": true
            }
        }
    ])
}

pub fn doctor(runtime: RuntimeName) -> serde_json::Value {
    let root = paths::project_root();
    match runtime {
        RuntimeName::Claude => json!({
            "runtime": "claude",
            "ok": true,
            "plugin_root": root,
            "data_dir": paths::data_dir(),
            "config_dir": paths::config_dir(),
            "state_dir": paths::state_dir(),
            "manifest_exists": root.as_ref().map(|r| r.join(".claude-plugin/plugin.json").exists()).unwrap_or(false),
            "hooks_exists": root.as_ref().map(|r| r.join("hooks/hooks.json").exists()).unwrap_or(false),
            "shared_adapter_exists": root.as_ref().map(|r| r.join("adapters/shared/claude-hooks.cjs").exists()).unwrap_or(false),
        }),
        RuntimeName::Codex => codex::doctor(),
    }
}
