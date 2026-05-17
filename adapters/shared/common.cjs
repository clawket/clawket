const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function resolvePluginRoot(fromDir) {
  return process.env.CODEX_PLUGIN_ROOT
    || process.env.CLAUDE_PLUGIN_ROOT
    || process.env.CLAWKET_ROOT
    || path.resolve(fromDir, '..', '..');
}

function clawketBin(pluginRoot) {
  return process.env.CLAWKET_BIN || path.resolve(pluginRoot, 'bin', 'clawket');
}

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    }).trim();
  } catch {
    return '';
  }
}

// execDiag: same as exec but returns { ok, stdout, stderr, code } for hook diagnostics.
// Used by ensureDaemon / doctor to surface failure reasons instead of silently returning ''.
function execDiag(cmd, opts = {}) {
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
    return { ok: true, stdout: String(stdout).trim(), stderr: '', code: 0 };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ? String(err.stdout).trim() : '',
      stderr: err.stderr ? String(err.stderr).trim() : String(err.message || ''),
      code: typeof err.status === 'number' ? err.status : -1,
    };
  }
}

function readHookInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf-8'));
  } catch {
    return {};
  }
}

function ensureXdgDirs() {
  for (const dir of [
    path.resolve(os.homedir(), '.local', 'share', 'clawket'),
    path.resolve(os.homedir(), '.cache', 'clawket'),
    path.resolve(os.homedir(), '.config', 'clawket'),
    path.resolve(os.homedir(), '.local', 'state', 'clawket'),
  ]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function cacheDir() {
  return process.env.CLAWKET_CACHE_DIR
    || path.resolve(process.env.XDG_CACHE_HOME || path.resolve(os.homedir(), '.cache'), 'clawket');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function readPromptFiles(pluginRoot, files) {
  return files
    .map((rel) => {
      try {
        return fs.readFileSync(path.resolve(pluginRoot, rel), 'utf-8').trim();
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

module.exports = {
  cacheDir,
  clawketBin,
  ensureXdgDirs,
  exec,
  execDiag,
  readHookInput,
  readJson,
  readPromptFiles,
  resolvePluginRoot,
  writeJson,
};
