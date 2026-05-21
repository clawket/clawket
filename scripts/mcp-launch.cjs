#!/usr/bin/env node
// MCP launcher for the Clawket plugin.
//
// Why this file exists:
//   Claude Code spawns plugin MCP servers immediately when a plugin is
//   enabled, before any SessionStart hook runs. plugin.json has no install
//   hook (verified against the official manifest schema). So the only way to
//   guarantee binaries are present at first MCP spawn is for the .mcp.json
//   entry itself to invoke a setup-aware launcher that lives inside the
//   plugin tarball.
//
// Single source of truth for setup logic:
//   This launcher does NOT duplicate setup logic. It calls
//   `claude-hooks.cjs::ensureInstalled` — the same function the SessionStart
//   hook and `scripts/setup.cjs` (manual/CI entry) call.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
  || process.env.CODEX_PLUGIN_ROOT
  || process.env.CLAWKET_ROOT
  || path.resolve(__dirname, '..');

function cliBinPath() {
  if (process.env.CLAWKET_BIN) return process.env.CLAWKET_BIN;
  const name = os.platform() === 'win32' ? 'clawket.exe' : 'clawket';
  return path.resolve(pluginRoot, 'bin', name);
}

(async () => {
  try {
    const hooks = require(path.resolve(pluginRoot, 'adapters', 'shared', 'claude-hooks.cjs'));
    await hooks.ensureInstalled(pluginRoot);
  } catch (err) {
    process.stderr.write(`[clawket-mcp] ensureInstalled failed: ${err.message}\n`);
  }

  const bin = cliBinPath();
  if (!fs.existsSync(bin)) {
    process.stderr.write(`[clawket-mcp] CLI binary missing at ${bin}\n`);
    process.exit(1);
  }
  const child = spawn(bin, ['mcp'], { stdio: 'inherit', env: process.env });
  child.on('error', (err) => {
    process.stderr.write(`[clawket-mcp] spawn failed: ${err.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
})();
