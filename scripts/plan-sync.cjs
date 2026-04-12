#!/usr/bin/env node
// Lattice PostToolUse hook for ExitPlanMode — auto-import plan file.
const { execSync } = require('child_process');
const { resolve, dirname } = require('path');
const { readdirSync, statSync } = require('fs');
const { homedir } = require('os');

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || resolve(dirname(__filename), '..');
const LATTICE = process.env.LATTICE_BIN || resolve(pluginRoot, 'bin', 'lattice');

function exec(cmd) {
  try { return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch { return ''; }
}

// Find the most recently modified plan file
const plansDir = resolve(homedir(), '.claude', 'plans');
try {
  const files = readdirSync(plansDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f, mtime: statSync(resolve(plansDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length > 0) {
    const latest = resolve(plansDir, files[0].name);
    const cwd = process.env.HOOK_CWD || process.cwd();

    // Import to lattice
    const result = exec(`${LATTICE} plan import "${latest}" --cwd "${cwd}"`);
    if (result) {
      process.stderr.write(`[lattice] Auto-imported plan: ${files[0].name}\n`);
    }
  }
} catch {
  // Plans dir not found or import failed — silently skip
}
