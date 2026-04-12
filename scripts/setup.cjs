#!/usr/bin/env node
// Lattice plugin setup: install daemon dependencies and build CLI.
const { execSync } = require('child_process');
const { existsSync, mkdirSync } = require('fs');
const { resolve, dirname } = require('path');

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || resolve(dirname(__filename), '..');
const daemonDir = resolve(pluginRoot, 'daemon');
const binDir = resolve(pluginRoot, 'bin');

function log(msg) { console.error(`[lattice-setup] ${msg}`); }
function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

// 1. Create XDG directories
const home = require('os').homedir();
for (const dir of [
  resolve(home, '.local', 'share', 'lattice'),
  resolve(home, '.cache', 'lattice'),
  resolve(home, '.config', 'lattice'),
  resolve(home, '.local', 'state', 'lattice'),
]) {
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); log(`Created ${dir}`); }
}

// 2. Install daemon dependencies
if (existsSync(resolve(daemonDir, 'package.json'))) {
  try {
    log('Installing daemon dependencies...');
    exec('npm install --production', { cwd: daemonDir, timeout: 120000 });
    log('Dependencies installed');
  } catch (e) {
    log(`WARNING: npm install failed: ${e.message}`);
  }
}

// 3. Check CLI binary
if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });
const cliBin = resolve(binDir, 'lattice');
if (existsSync(cliBin)) {
  log('CLI binary found');
} else {
  // Try cargo build if Rust is available
  const cliDir = resolve(pluginRoot, 'cli');
  if (existsSync(resolve(cliDir, 'Cargo.toml'))) {
    try {
      exec('cargo --version');
      log('Building CLI from source...');
      exec('cargo build --release', { cwd: cliDir, timeout: 300000 });
      const built = resolve(cliDir, 'target', 'release', 'lattice');
      if (existsSync(built)) {
        require('fs').copyFileSync(built, cliBin);
        require('fs').chmodSync(cliBin, 0o755);
        log('CLI binary built');
      }
    } catch { log('WARNING: Rust not available. Place lattice binary in bin/'); }
  }
}

log('Setup complete!');
