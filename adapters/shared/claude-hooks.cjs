const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const tls = require('tls');

const {
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
} = require('./common.cjs');
const { buildSummary, parseInProgressTasks } = require('./session-context.cjs');

const CLI_REPO = process.env.CLAWKET_CLI_REPO || 'clawket/cli';
const DAEMON_REPO = process.env.CLAWKET_DAEMON_REPO || 'clawket/daemon';
const WEB_REPO = process.env.CLAWKET_WEB_REPO || 'clawket/web';

// Corporate MITM proxies inject a private CA into the macOS keychain (or
// Linux system trust store). Node's default TLS stack ignores those stores
// and uses only its bundled Mozilla roots, which is why `curl` succeeds but
// Node fails with "self-signed certificate in certificate chain". We merge
// root + system CAs into the `ca` option on in-process https downloads.
function resolveCaList() {
  if (typeof tls.getCACertificates !== 'function') return null;
  try {
    const system = tls.getCACertificates('system') || [];
    if (!system.length) return null;
    const bundled = tls.rootCertificates || [];
    return [...bundled, ...system];
  } catch {
    return null;
  }
}

// Component versions are pinned per plugin release in `<pluginRoot>/components.json`.
// Env vars (CLAWKET_CLI_VERSION, CLAWKET_DAEMON_VERSION) override for local dev only.
function loadComponentsManifest(pluginRoot) {
  const manifestPath = path.resolve(pluginRoot, 'components.json');
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (error) {
    throw new Error(`components manifest missing or invalid at ${manifestPath}: ${error.message}`);
  }
}

function runtime(pluginRoot) {
  return {
    pluginRoot,
    clawket: clawketBin(pluginRoot),
  };
}

function allow() {
  console.log(JSON.stringify({}));
  process.exit(0);
}

function readOnlyBashPatterns() {
  return [
    /^(npx\s+)?tsc(\s|$)/,
    /^(npx\s+)?eslint(\s|$)/,
    /^(npx\s+)?prettier(\s|$)/,
    /^(npm|pnpm|yarn|bun)\s+test/,
    /^(npm|pnpm|yarn|bun)\s+run\s+(test|lint|check|typecheck|build)/,
    /^(npx|pnpm\s+exec)\s+vitest/,
    /^(npx|pnpm\s+exec)\s+jest/,
    /^git\s+(status|log|diff|show|branch|stash\s+list|remote|tag)/,
    /^(ls|pwd|wc|du|df|which|where|type|file|stat)\b/,
    /^(cat|head|tail|less|more)\s/,
    /^(curl|wget)\s/,
    /^(node|python3?|ruby)\s+-e\s/,
    /^echo\s/,
    /^(docker|podman)\s+(ps|images|logs|inspect)/,
    /^cargo\s+(check|test|clippy)/,
    /^lsof\s/,
  ];
}

function detectCliTarget() {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (platform === 'win32') {
    throw new Error(
      'Windows is not yet supported by the Clawket CLI. ' +
        'Use WSL2 or macOS/Linux. Track: https://github.com/clawket/cli/issues'
    );
  }
  throw new Error(`Unsupported platform: ${platform}/${arch}`);
}

function downloadToFileOnce(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const ca = resolveCaList();
    const opts = ca ? { ca } : {};
    https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return downloadToFileOnce(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        const err = new Error(`HTTP ${res.statusCode} for ${url}`);
        err.statusCode = res.statusCode;
        return reject(err);
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

// GitHub's release CDN occasionally returns transient 5xx (502/503/504) under
// load. Retry with exponential backoff so a single hiccup does not poison
// plugin setup. Network errors (ECONNRESET/ETIMEDOUT/EAI_AGAIN) are retried
// for the same reason. 4xx is fatal — those are real misconfiguration.
async function downloadToFile(url, dest, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await downloadToFileOnce(url, dest);
    } catch (error) {
      lastError = error;
      const transient =
        (error.statusCode && error.statusCode >= 500 && error.statusCode < 600) ||
        ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED'].includes(error.code);
      if (!transient || attempt === maxAttempts) throw error;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      process.stderr.write(`[clawket-setup] transient ${error.message} — retry ${attempt}/${maxAttempts - 1} in ${delay}ms\n`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// Version tracking for installed components.
//
// Existence-only checks (`fs.existsSync(binPath)`) mean components.json version
// bumps never trigger redownload for users who already have the previous
// version installed. A marker file written next to each binary/bundle records
// the installed version; mismatch forces reinstall. Missing marker on an
// existing binary is treated as "unknown version" → reinstall (one-time cost
// when upgrading across this change).
function readInstalledVersion(markerPath) {
  try {
    return fs.readFileSync(markerPath, 'utf-8').trim();
  } catch {
    return null;
  }
}

function writeInstalledVersion(markerPath, version) {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${version}\n`);
  } catch (err) {
    process.stderr.write(`[clawket-setup] WARNING: failed to record version at ${markerPath}: ${err.message}\n`);
  }
}

async function ensureCliBinary(pluginRoot, version) {
  const cliVersion = process.env.CLAWKET_CLI_VERSION || version;
  if (!cliVersion) throw new Error('CLI version missing (components.json.cli)');

  const binDir = path.resolve(pluginRoot, 'bin');
  const binName = os.platform() === 'win32' ? 'clawket.exe' : 'clawket';
  const binPath = path.resolve(binDir, binName);
  const markerPath = path.resolve(binDir, '.clawket-version');

  if (fs.existsSync(binPath) && readInstalledVersion(markerPath) === cliVersion) {
    return binPath;
  }
  if (fs.existsSync(binPath)) {
    process.stderr.write(
      `[clawket-setup] CLI version mismatch (want ${cliVersion}, have ${readInstalledVersion(markerPath) || 'unknown'}). Reinstalling.\n`
    );
    try { fs.unlinkSync(binPath); } catch {}
  }

  fs.mkdirSync(binDir, { recursive: true });
  const target = detectCliTarget();
  const ext = os.platform() === 'win32' ? 'zip' : 'tar.gz';
  const assetName = `clawket-${cliVersion}-${target}.${ext}`;
  const url = `https://github.com/${CLI_REPO}/releases/download/${cliVersion}/${assetName}`;
  const archive = path.resolve(binDir, assetName);

  process.stderr.write(`[clawket-setup] Downloading CLI ${cliVersion} for ${target}...\n`);
  await downloadToFile(url, archive);
  if (ext === 'tar.gz') {
    exec(`tar -xzf "${archive}" -C "${binDir}"`);
    const extracted = path.resolve(binDir, `clawket-${cliVersion}-${target}`, 'clawket');
    if (fs.existsSync(extracted)) {
      fs.copyFileSync(extracted, binPath);
      fs.chmodSync(binPath, 0o755);
    }
  } else {
    exec(`cd "${binDir}" && unzip -o "${assetName}"`);
    const extracted = path.resolve(binDir, `clawket-${cliVersion}-${target}`, 'clawket.exe');
    if (fs.existsSync(extracted)) fs.copyFileSync(extracted, binPath);
  }
  fs.unlinkSync(archive);
  writeInstalledVersion(markerPath, cliVersion);
  process.stderr.write(`[clawket-setup] CLI ${cliVersion} installed at ${binPath}\n`);
  return binPath;
}

async function ensureDaemonBinary(pluginRoot, version) {
  const daemonVersion = process.env.CLAWKET_DAEMON_VERSION || version;
  if (!daemonVersion) throw new Error('daemon version missing (components.json.daemon)');

  const binDir = path.resolve(pluginRoot, 'daemon', 'bin');
  const binName = os.platform() === 'win32' ? 'clawketd.exe' : 'clawketd';
  const binPath = path.resolve(binDir, binName);
  const markerPath = path.resolve(binDir, '.clawket-version');

  if (fs.existsSync(binPath) && readInstalledVersion(markerPath) === daemonVersion) {
    return binPath;
  }
  if (fs.existsSync(binPath)) {
    process.stderr.write(
      `[clawket-setup] daemon version mismatch (want ${daemonVersion}, have ${readInstalledVersion(markerPath) || 'unknown'}). Reinstalling.\n`
    );
    try { fs.unlinkSync(binPath); } catch {}
  }

  fs.mkdirSync(binDir, { recursive: true });
  const target = detectCliTarget();
  const ext = os.platform() === 'win32' ? 'zip' : 'tar.gz';
  const assetName = `clawketd-${daemonVersion}-${target}.${ext}`;
  const url = `https://github.com/${DAEMON_REPO}/releases/download/${daemonVersion}/${assetName}`;
  const archive = path.resolve(binDir, assetName);

  process.stderr.write(`[clawket-setup] Downloading daemon ${daemonVersion} for ${target}...\n`);
  await downloadToFile(url, archive);
  if (ext === 'tar.gz') {
    exec(`tar -xzf "${archive}" -C "${binDir}"`);
    const extracted = path.resolve(binDir, `clawketd-${daemonVersion}-${target}`, 'clawketd');
    if (fs.existsSync(extracted)) {
      fs.copyFileSync(extracted, binPath);
      fs.chmodSync(binPath, 0o755);
    }
  } else {
    exec(`cd "${binDir}" && unzip -o "${assetName}"`);
    const extracted = path.resolve(binDir, `clawketd-${daemonVersion}-${target}`, 'clawketd.exe');
    if (fs.existsSync(extracted)) fs.copyFileSync(extracted, binPath);
  }
  fs.unlinkSync(archive);
  writeInstalledVersion(markerPath, daemonVersion);
  process.stderr.write(`[clawket-setup] daemon ${daemonVersion} installed at ${binPath}\n`);
  return binPath;
}

async function ensureWebBundle(pluginRoot, version) {
  const webVersion = process.env.CLAWKET_WEB_VERSION || version;
  if (!webVersion) throw new Error('web version missing (components.json.web)');

  const webRoot = path.resolve(pluginRoot, 'web');
  const indexFile = path.resolve(webRoot, 'dist', 'index.html');
  const markerPath = path.resolve(webRoot, '.clawket-version');

  if (fs.existsSync(indexFile) && readInstalledVersion(markerPath) === webVersion) {
    return webRoot;
  }
  if (fs.existsSync(indexFile)) {
    process.stderr.write(
      `[clawket-setup] web version mismatch (want ${webVersion}, have ${readInstalledVersion(markerPath) || 'unknown'}). Reinstalling.\n`
    );
    try { fs.rmSync(path.resolve(webRoot, 'dist'), { recursive: true, force: true }); } catch {}
  }

  fs.mkdirSync(webRoot, { recursive: true });
  const assetName = `clawket-web-${webVersion}.tar.gz`;
  const url = `https://github.com/${WEB_REPO}/releases/download/${webVersion}/${assetName}`;
  const archive = path.resolve(webRoot, assetName);

  process.stderr.write(`[clawket-setup] Downloading web ${webVersion}...\n`);
  await downloadToFile(url, archive);
  exec(`tar -xzf "${archive}" -C "${webRoot}"`);
  fs.unlinkSync(archive);

  if (!fs.existsSync(indexFile)) {
    throw new Error(`web bundle extracted but dist/index.html missing at ${indexFile}`);
  }
  writeInstalledVersion(markerPath, webVersion);
  process.stderr.write(`[clawket-setup] web ${webVersion} installed at ${webRoot}\n`);
  return webRoot;
}

function resolveWebDir(pluginRoot) {
  if (process.env.CLAWKET_WEB_DIR) return process.env.CLAWKET_WEB_DIR;
  const distPath = path.resolve(pluginRoot, 'web', 'dist');
  return fs.existsSync(path.join(distPath, 'index.html')) ? distPath : null;
}

// Symlink the plugin-managed clawket binary into ~/.local/bin so the user can
// invoke `clawket daemon restart` and friends from a normal shell. The skill
// docs document unqualified `clawket` usage; without this symlink, the binary
// is only discoverable at `<pluginRoot>/bin/clawket`, which users won't know.
function linkCliToUserBin(pluginRoot) {
  if (os.platform() === 'win32') return;
  const src = path.resolve(pluginRoot, 'bin', 'clawket');
  if (!fs.existsSync(src)) return;

  const userBin = path.resolve(os.homedir(), '.local', 'bin');
  const dest = path.resolve(userBin, 'clawket');
  try {
    fs.mkdirSync(userBin, { recursive: true });
    try { fs.unlinkSync(dest); } catch (e) {
      if (e && e.code !== 'ENOENT') throw e;
    }
    fs.symlinkSync(src, dest);
    process.stderr.write(`[clawket-setup] Linked CLI into ${dest}\n`);
  } catch (err) {
    process.stderr.write(`[clawket-setup] WARNING: failed to link ${dest}: ${err.message}\n`);
    return;
  }

  const pathEntries = (process.env.PATH || '').split(path.delimiter);
  if (!pathEntries.includes(userBin)) {
    process.stderr.write(
      `[clawket-setup] NOTE: ${userBin} is not on your PATH.\n` +
      `[clawket-setup] Add it with:  export PATH="$HOME/.local/bin:$PATH"\n` +
      `[clawket-setup] (put it in ~/.zshrc or ~/.bashrc to persist).\n`
    );
  }
}

// ensureDaemon — best-effort daemon liveness check with visible diagnostics.
//
// Contract (CLAWKET_DAEMON_BIN injection):
//   1. If a plugin-managed daemon binary exists at <pluginRoot>/daemon/bin/clawketd,
//      inject CLAWKET_DAEMON_BIN so the CLI uses that specific binary even when
//      another clawketd is on PATH (e.g. a stale dev build).
//   2. The env is passed to BOTH `clawket daemon status` and `clawket daemon start`.
//   3. On start failure, stderr/stdout from clawketd is forwarded to the user
//      (was silently swallowed pre-CK-380/CK-382). Users can then run
//      `clawket doctor` for a full health snapshot.
// Parse `clawket daemon status` output. clawketd emits pretty-printed JSON:
//   { "alive": true, "healthy": true, "pid": N, "port": N, ... }
// A non-alive daemon exits 1 from `cmd_status`, which makes execSync throw and
// the exec() wrapper returns ''. A successful call always yields parseable JSON.
function isDaemonRunning(clawket, env) {
  const raw = exec(`${clawket} daemon status`, { env });
  if (!raw) return false;
  try {
    const obj = JSON.parse(raw);
    return obj.alive === true;
  } catch {
    // Legacy fallback: older Node @clawket/daemon emitted plain text with "running".
    return raw.includes('running');
  }
}

function ensureDaemon(clawket, pluginRoot) {
  const daemonBin = path.resolve(pluginRoot, 'daemon', 'bin', 'clawketd');
  const hasPluginBin = fs.existsSync(daemonBin);
  const webDir = resolveWebDir(pluginRoot);
  const env = { ...process.env };
  if (hasPluginBin) env.CLAWKET_DAEMON_BIN = daemonBin;
  if (webDir) env.CLAWKET_WEB_DIR = webDir;

  if (isDaemonRunning(clawket, env)) return;

  const startRes = execDiag(`${clawket} daemon start`, { env });
  if (!startRes.ok) {
    process.stderr.write(
      `[clawket] daemon start failed (exit ${startRes.code}). stderr: ${startRes.stderr || '(empty)'}\n` +
      `[clawket] run 'clawket doctor' for diagnostics` +
      (hasPluginBin ? ` (using plugin daemon at ${daemonBin})` : ' (no plugin daemon binary found)') +
      `\n`
    );
    return;
  }

  for (let i = 0; i < 10; i += 1) {
    if (isDaemonRunning(clawket, env)) return;
    exec('sleep 0.3');
  }
  process.stderr.write(
    `[clawket] daemon did not become ready within 3s. Run 'clawket doctor'.\n`
  );
}

function getWebUrl() {
  try {
    const portFile = path.join(cacheDir(), 'clawketd.port');
    const port = fs.readFileSync(portFile, 'utf-8').trim();
    return `http://localhost:${port}`;
  } catch {
    return '';
  }
}

function apiPost(port, pathname, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(`http://127.0.0.1:${port}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

// Idempotent install gate. plugin.json `setup` is not auto-executed by Claude
// Code (the field is not in the official plugin manifest schema), so the very
// first SessionStart after `/plugin install` must perform setup itself.
// Subsequent sessions are a no-op when version markers match — the cost of
// the gate is a few syscalls on the warm path.
async function ensureInstalled(pluginRoot) {
  let manifest;
  try {
    manifest = loadComponentsManifest(pluginRoot);
  } catch (err) {
    process.stderr.write(`[clawket-setup] WARNING: components.json missing or invalid: ${err.message}\n`);
    return;
  }

  const cliBin = path.resolve(pluginRoot, 'bin', os.platform() === 'win32' ? 'clawket.exe' : 'clawket');
  const daemonBin = path.resolve(pluginRoot, 'daemon', 'bin', os.platform() === 'win32' ? 'clawketd.exe' : 'clawketd');
  const webIndex = path.resolve(pluginRoot, 'web', 'dist', 'index.html');
  const cliMarker = path.resolve(pluginRoot, 'bin', '.clawket-version');
  const daemonMarker = path.resolve(pluginRoot, 'daemon', 'bin', '.clawket-version');
  const webMarker = path.resolve(pluginRoot, 'web', '.clawket-version');

  const cliOk = fs.existsSync(cliBin) && readInstalledVersion(cliMarker) === manifest.cli;
  const daemonOk = fs.existsSync(daemonBin) && readInstalledVersion(daemonMarker) === manifest.daemon;
  const webOk = fs.existsSync(webIndex) && readInstalledVersion(webMarker) === manifest.web;
  if (cliOk && daemonOk && webOk) return;

  process.stderr.write('[clawket-setup] First-run install (downloading binaries — this can take ~30s)\n');
  await runSetup();
}

async function runSessionStart() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  await ensureInstalled(pluginRoot);
  const { clawket } = runtime(pluginRoot);
  ensureDaemon(clawket, pluginRoot);

  const cwd = process.env.HOOK_CWD || process.cwd();
  const context = exec(`${clawket} dashboard --cwd "${cwd}" --show active`);
  const rules = readPromptFiles(pluginRoot, ['prompts/shared/rules.md', 'prompts/claude/runtime.md']);
  const webUrl = getWebUrl();

  if (!context) {
    const noProjectMsg = `Clawket: No project registered for this directory.\nRun: clawket project create "<name>" --cwd "${cwd}"`;
    const statusLine = webUrl ? `  Web: ${webUrl}` : '';
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: noProjectMsg + (rules ? `\n\n${rules}` : ''),
      },
      systemMessage: `Clawket active — no project for this directory${statusLine ? `\n${statusLine}` : ''}`,
    }));
    process.exit(0);
  }

  const summary = buildSummary(context);
  const statusLine = webUrl ? `Daemon: running Web: ${webUrl}` : 'Daemon: running';
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context + (rules ? `\n\n${rules}` : ''),
    },
    systemMessage: `${summary}\n${statusLine}`,
  }));
}

function runUserPromptSubmit() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const cwd = hookInput.cwd || process.env.HOOK_CWD || process.cwd();
  const context = exec(`${clawket} dashboard --cwd "${cwd}" --show active`);

  if (!context) allow();

  const inProgressTasks = parseInProgressTasks(context);
  if (inProgressTasks.length > 0) {
    const taskList = inProgressTasks
      .map((task) => `- [${task.id}] ${task.title}${task.meta ? ` (${task.meta})` : ''}`)
      .join('\n');
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `# Active Clawket Tasks\n${taskList}`,
      },
    }));
    return;
  }

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: '# Clawket: 활성 태스크 없음 — 작업 전 태스크 등록 필요',
    },
  }));
}

function runPreToolUse() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const toolName = hookInput.tool_name || process.env.HOOK_TOOL_NAME || '';
  const toolInput = hookInput.tool_input || {};

  const readOnly = new Set([
    'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
    'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
    'ToolSearch', 'Skill', 'ScheduleWakeup',
    'mcp__playwright__browser_snapshot', 'mcp__playwright__browser_take_screenshot',
    'mcp__playwright__browser_navigate', 'mcp__playwright__browser_click',
    'mcp__playwright__browser_console_messages', 'mcp__playwright__browser_resize',
  ]);
  const taskTools = new Set(['TaskCreate', 'TaskUpdate']);
  const agentTools = new Set(['Agent', 'TeamCreate', 'SendMessage']);
  const mutatingTools = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit']);

  if (readOnly.has(toolName)) allow();
  if (!agentTools.has(toolName) && !mutatingTools.has(toolName) && !taskTools.has(toolName)) allow();

  if (toolName === 'Bash') {
    const cmd = (toolInput.command || '').trim();
    if (cmd.startsWith('clawket ') || cmd.includes('clawket ')) allow();
    if (readOnlyBashPatterns().some((re) => re.test(cmd))) allow();
  }

  const cwd = hookInput.cwd || process.env.HOOK_CWD || process.cwd();
  const context = exec(`${clawket} dashboard --cwd "${cwd}" --show active`);
  if (!context) allow();

  const tasksJson = exec(`${clawket} task list --status in_progress`);
  let inProgressTasks = [];
  try { inProgressTasks = JSON.parse(tasksJson || '[]'); } catch {}

  if (inProgressTasks.length === 0) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Clawket: 활성 태스크가 없습니다. 작업 전 `clawket task create` 또는 `clawket task update <ID> --status in_progress`를 실행하세요.',
      },
    }));
    process.exit(0);
  }

  if (agentTools.has(toolName)) {
    const agentName = toolInput.name || '';
    if (agentName) {
      let taskForAgent = inProgressTasks.find((task) => task.assignee === agentName);
      if (!taskForAgent) {
        const todoJson = exec(`${clawket} task list --status todo`);
        let todoTasks = [];
        try { todoTasks = JSON.parse(todoJson || '[]'); } catch {}
        const todoForAgent = todoTasks.find((task) => task.assignee === agentName);
        if (todoForAgent) {
          exec(`${clawket} task update "${todoForAgent.id}" --status in_progress`);
          taskForAgent = todoForAgent;
        } else {
          console.log(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `Clawket: "${agentName}"에 대한 태스크가 없습니다. \`clawket task create --assignee ${agentName}\`으로 먼저 등록하세요.`,
            },
          }));
          process.exit(0);
        }
      }

      const pendingFile = path.join(cacheDir(), 'agent-pending.json');
      const pending = readJson(pendingFile, []);
      pending.push({
        name: agentName,
        task_id: taskForAgent.id,
        subagent_type: toolInput.subagent_type || 'general-purpose',
        ts: Date.now(),
      });
      writeJson(pendingFile, pending);

      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: `\n\n---\n[Clawket] 작업 티켓: ${taskForAgent.ticket_number} — ${taskForAgent.title}\nTask ID: ${taskForAgent.id}`,
        },
      }));
      process.exit(0);
    }
  }

  allow();
}

function runPostToolUse() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const sessionId = process.env.CLAUDE_SESSION_ID || '';
  const hookInput = readHookInput();
  const toolName = hookInput.tool_name || '';
  const toolInput = hookInput.tool_input || {};

  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = toolInput.file_path || '';
    if (!filePath || !sessionId) process.exit(0);
    try {
      const runsJson = exec(`${clawket} run list --session-id "${sessionId}"`);
      const runs = JSON.parse(runsJson || '[]');
      const activeRun = runs.find((run) => !run.ended_at);
      if (activeRun) {
        exec(`${clawket} task append-body "${activeRun.task_id}" --text "\n[${toolName}] ${filePath}"`);
      } else {
        const portFile = path.join(cacheDir(), 'clawketd.port');
        const port = fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf-8').trim() : null;
        if (port) {
          apiPost(port, '/activity', {
            entity_type: 'task',
            entity_id: 'session',
            action: 'updated',
            field: 'file_edit',
            new_value: `[${toolName}] ${filePath}`,
            actor: 'main',
          });
        }
      }
    } catch {}
  }
}

function runPlanSync() {
  const plansDir = path.resolve(os.homedir(), '.claude', 'plans');
  const now = Date.now();
  const files = (() => {
    try {
      return fs.readdirSync(plansDir)
        .filter((file) => file.endsWith('.md'))
        .map((file) => ({ path: path.resolve(plansDir, file), mtime: fs.statSync(path.resolve(plansDir, file)).mtimeMs }))
        .filter((file) => now - file.mtime < 120_000)
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  })();

  if (!files.length) allow();

  const planFile = files[0].path;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `# Clawket: Plan Mode 종료 — 클라켓에 등록 필요

ExitPlanMode로 승인된 플랜 파일: \`${planFile}\`

이 플랜을 클라켓에 등록하세요:
1. \`clawket plan create\` 또는 기존 플랜에 Unit/Task 추가
2. \`clawket unit create\` — 각 Unit 등록
3. \`clawket task create\` — 각 Task 등록 (--assignee, --priority 포함)
4. 모든 Task는 active Cycle에 배정

플랜 파일을 직접 Read해서 내용을 파악하고, clawket CLI로 등록하세요.
파일을 파싱하지 않고 당신이 직접 이해해서 구조화하세요.`,
    },
  }));
}

function runSubagentStart() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const agentId = hookInput.agent_id || '';
  const agentType = hookInput.agent_type || 'general-purpose';
  if (!agentId) process.exit(0);

  const pendingFile = path.join(cacheDir(), 'agent-pending.json');
  const pending = readJson(pendingFile, []);
  if (!pending.length) process.exit(0);

  const idx = pending.findIndex((entry) => (entry.subagent_type || 'general-purpose') === (agentType || 'general-purpose'));
  if (idx === -1) process.exit(0);
  const matched = pending.splice(idx, 1)[0];
  if (pending.length) writeJson(pendingFile, pending);
  else if (fs.existsSync(pendingFile)) fs.unlinkSync(pendingFile);
  exec(`${clawket} task update "${matched.task_id}" --agent-id "${agentId}"`);
}

function runSubagentStop() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const agentId = hookInput.agent_id || '';
  if (!agentId) process.exit(0);

  let tasks = [];
  try { tasks = JSON.parse(exec(`${clawket} task list --status in_progress --agent-id "${agentId}"`) || '[]'); } catch {}
  if (!tasks.length) process.exit(0);

  const task = tasks[0];
  const lastMsg = hookInput.last_assistant_message || '';
  const summary = lastMsg.length > 500 ? `${lastMsg.slice(0, 500)}...` : lastMsg;
  if (summary) exec(`${clawket} task append-body "${task.id}" --text "\n[SubagentStop] ${summary.replace(/"/g, '\\"')}"`);
  exec(`${clawket} task update "${task.id}" --status done --comment "자동 완료: 에이전트 종료 (agent_id: ${agentId})"`);
}

function runTaskCreated() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const teammateName = hookInput.teammate_name || '';
  if (!teammateName) process.exit(0);
  let tasks = [];
  try { tasks = JSON.parse(exec(`${clawket} task list --status todo`) || '[]'); } catch {}
  const task = tasks.find((item) => item.assignee === teammateName);
  if (task) exec(`${clawket} task update "${task.id}" --status in_progress --comment "자동 시작: 팀 에이전트 ${teammateName} 태스크 생성"`);
}

function runTaskCompleted() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const teammateName = hookInput.teammate_name || '';
  if (!teammateName) process.exit(0);
  let tasks = [];
  try { tasks = JSON.parse(exec(`${clawket} task list --status in_progress`) || '[]'); } catch {}
  const task = tasks.find((item) => item.assignee === teammateName);
  if (task) exec(`${clawket} task update "${task.id}" --status done --comment "자동 완료: 팀 에이전트 ${teammateName} 태스크 완료"`);
}

function runStop() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const sessionId = process.env.CLAUDE_SESSION_ID || '';
  if (!sessionId) process.exit(0);

  try {
    const runs = JSON.parse(exec(`${clawket} run list --session-id "${sessionId}"`) || '[]');
    for (const run of runs) {
      if (!run.ended_at) exec(`${clawket} run finish "${run.id}" --result session_ended --notes "Auto-closed by Stop hook"`);
    }
  } catch {}
}

async function runSetup() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  ensureXdgDirs();
  const manifest = loadComponentsManifest(pluginRoot);
  try {
    await ensureCliBinary(pluginRoot, manifest.cli);
  } catch (error) {
    process.stderr.write(`[clawket-setup] WARNING: CLI binary download failed: ${error.message}\n`);
    process.stderr.write(`[clawket-setup] Hint: place a clawket binary at ${path.resolve(pluginRoot, 'bin', 'clawket')} manually, or rerun setup with CLAWKET_CLI_VERSION override.\n`);
  }
  try {
    await ensureDaemonBinary(pluginRoot, manifest.daemon);
  } catch (error) {
    process.stderr.write(`[clawket-setup] WARNING: daemon binary download failed: ${error.message}\n`);
    process.stderr.write(`[clawket-setup] Hint: place a clawketd binary at ${path.resolve(pluginRoot, 'daemon', 'bin', 'clawketd')} manually, or rerun setup with CLAWKET_DAEMON_VERSION override.\n`);
  }
  try {
    await ensureWebBundle(pluginRoot, manifest.web);
  } catch (error) {
    process.stderr.write(`[clawket-setup] WARNING: web bundle download failed: ${error.message}\n`);
    process.stderr.write(`[clawket-setup] Hint: extract clawket-web-<version>.tar.gz into ${path.resolve(pluginRoot, 'web')} manually, or rerun setup with CLAWKET_WEB_VERSION override.\n`);
  }
  linkCliToUserBin(pluginRoot);
  // Node's default https Agent keeps download sockets alive past completion,
  // which prevents natural event-loop exit. Destroy the pool explicitly so
  // Claude Code's install hook does not block on the plugin.
  try { https.globalAgent.destroy(); } catch {}
  try { http.globalAgent.destroy(); } catch {}
}

module.exports = {
  runPlanSync,
  runPostToolUse,
  runPreToolUse,
  runSessionStart,
  runSetup,
  runStop,
  runSubagentStart,
  runSubagentStop,
  runTaskCompleted,
  runTaskCreated,
  runUserPromptSubmit,
  // Exposed for test harnesses only.
  __test__: {
    ensureCliBinary,
    ensureDaemonBinary,
    ensureWebBundle,
    readInstalledVersion,
    writeInstalledVersion,
  },
};
