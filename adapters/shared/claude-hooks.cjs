const crypto = require('crypto');
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
const bashClassifier = require('./bash-classifier.cjs');
const { execFileSync } = require('child_process');
const { t: _t, resolveLocale, localeChain } = require('./locale.cjs');

// Lazy locale resolution: cached after first call so every hook invocation
// pays at most one env-var read. The locale is process-scoped (one hook = one
// process) so caching is safe.
//
// HOOK-081/152 — on first resolution we emit a single stderr line that names
// the chosen locale and the full fallback chain (e.g. "ja→ko→en") so the
// user can verify the env vars are flowing. Suppressed by CLAWKET_QUIET=1.
let _locale = null;
let _localeAnnounced = false;
function t(key, vars) {
  if (!_locale) {
    _locale = resolveLocale();
    if (!_localeAnnounced && process.env.CLAWKET_QUIET !== '1') {
      _localeAnnounced = true;
      try {
        const chain = localeChain(_locale).join('→');
        process.stderr.write(`[clawket] locale=${_locale} (fallback chain: ${chain})\n`);
      } catch {}
    }
  }
  let msg = _t(key, _locale);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      msg = msg.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
  }
  return msg;
}

const CLI_REPO = process.env.CLAWKET_CLI_REPO || 'clawket/cli';
const DAEMON_REPO = process.env.CLAWKET_DAEMON_REPO || 'clawket/daemon';
const WEB_REPO = process.env.CLAWKET_WEB_REPO || 'clawket/web';
const DESKTOP_REPO = process.env.CLAWKET_DESKTOP_REPO || 'clawket/desktop';

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

// LM-11057: PreToolUse-specific allow emitter. Newer Claude Code releases
// schema-validate hook output and reject the bare `{}` produced by `allow()`
// with `Hook JSON output validation failed — (root): Invalid input`. Emit the
// fully-qualified PreToolUse decision instead so the harness always parses it.
// allow() is left unchanged for non-PreToolUse hooks (PostToolUse, Subagent*)
// where the empty-object form remains accepted.
// `additionalContext` (optional) MUST be a plain string — the PreToolUse schema
// rejects objects, and a rejected payload is dropped whole, so any decision it
// carried is lost (fail-open) while the user sees the validation error on every
// tool call. Callers that want to surface data (e.g. the resolved tier) pass a
// pre-formatted string here rather than hand-rolling their own JSON, so the
// `permissionDecision` field can never be omitted by accident.
function allowPreToolUse(additionalContext) {
  const hookSpecificOutput = {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
  };
  if (additionalContext) hookSpecificOutput.additionalContext = String(additionalContext);
  console.log(JSON.stringify({ hookSpecificOutput }));
  process.exit(0);
}

// HOOK-251: append `{event,at}` JSON line to ~/.local/state/clawket/hook-events.log
// so `clawket doctor` can show last_fired per hook event. Best-effort: any I/O
// error is swallowed (the user-visible doctor row falls back to "—").
function recordHookEvent(name) {
  try {
    const stateDir = process.env.XDG_STATE_HOME
      ? path.join(process.env.XDG_STATE_HOME, 'clawket')
      : path.join(os.homedir(), '.local', 'state', 'clawket');
    fs.mkdirSync(stateDir, { recursive: true });
    const line = JSON.stringify({ event: name, at: new Date().toISOString() }) + '\n';
    fs.appendFileSync(path.join(stateDir, 'hook-events.log'), line);
  } catch {}
}

// LM-257: Project-level disable toggle (parity with dashboard ProjectSettings).
// `clawket project disable <id>` flips `projects.enabled = 0`. Without this
// guard the hooks kept enforcing despite the dashboard's "Disabled — Claude
// works without Clawket constraints" claim — the toggle was cosmetic.
//
// Returns `true` when this cwd resolves to a project with `enabled = 0`. On
// any failure (daemon down, no project matches, malformed JSON) we return
// `false` so the hooks fall through to their normal enforcement path —
// fail-closed for safety.
function isProjectDisabled(clawket, cwd) {
  if (!cwd) return false;
  const out = exec(`${clawket} project resolve --cwd "${cwd}" --format json`);
  if (!out) return false;
  let proj;
  try { proj = JSON.parse(out); } catch { return false; }
  if (!proj || typeof proj !== 'object') return false;
  return proj.enabled === 0;
}

// destructive-patterns.json catalog — loaded once, regex compiled once. Single
// source of truth for shell hard-block rules (LM-7). See SSoT artifact for the
// post-incident analysis that motivated each entry.
//
// v3 change (FIX-PLUGIN-012): `reason` and `remediation` may be either a plain
// string (v1 format) or a locale-keyed object {en, ko, ja}. We resolve to the
// active locale at load time so callers receive a plain string regardless of
// format version. The `CLAWKET_ALLOW_DESTRUCTIVE` bypass keyword is removed
// from pattern descriptions — the bypass is a hook-layer concern only.
let _destructivePatternsCache = null;
function loadDestructivePatterns(pluginRoot) {
  if (_destructivePatternsCache) return _destructivePatternsCache;
  const file = path.resolve(pluginRoot, 'adapters', 'shared', 'destructive-patterns.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const locale = resolveLocale();
    const resolveField = (field) => {
      if (!field) return '';
      if (typeof field === 'string') return field;
      // Locale-keyed object: prefer exact locale, then 'en', then first value.
      return field[locale] || field['en'] || Object.values(field)[0] || '';
    };
    _destructivePatternsCache = (parsed.patterns || []).map((p) => ({
      ...p,
      reason: resolveField(p.reason),
      remediation: resolveField(p.remediation),
      compiled: new RegExp(p.regex, p.flags || ''),
    }));
  } catch (err) {
    process.stderr.write(`[clawket] WARNING: destructive-patterns.json load failed (${err.message}). Hard-block disabled this run.\n`);
    _destructivePatternsCache = [];
  }
  return _destructivePatternsCache;
}

// Destructive rules are evaluated on the commands the shell would execute
// (bash-classifier.cjs), not on the raw text: a heredoc body, a grep pattern
// or a commit message that merely mentions `git reset --hard` is data, while
// `git -C . reset --hard`, `bash -c "…"`, `eval`, `xargs` and `$(…)` are
// unwrapped and matched. Unparseable input falls back to each entry's raw
// `regex` so the guard fails closed.
function detectDestructive(cmd, pluginRoot, analysis) {
  if (!cmd || typeof cmd !== 'string') return null;
  return bashClassifier.detectDestructive(cmd, loadDestructivePatterns(pluginRoot), analysis);
}

// Best-effort audit trail for hard-blocked commands. Posts to daemon /activity
// (already used by PostToolUse). Failure is non-fatal — the deny itself is the
// primary guard; audit logging is observability only.
function recordDestructiveBlock(pattern, cmd) {
  try {
    const portFile = path.join(cacheDir(), 'clawketd.port');
    if (!fs.existsSync(portFile)) return;
    const port = fs.readFileSync(portFile, 'utf-8').trim();
    if (!port) return;
    apiPost(port, '/activity', {
      entity_type: 'task',
      entity_id: 'session',
      action: 'destructive_blocked',
      field: pattern.id,
      old_value: cmd.slice(0, 500),
      new_value: pattern.category,
    });
  } catch {}
}

// Bash fast paths that skip the active-task gate. The decision comes from
// bash-classifier.cjs: every executed command must be read-only (per-command
// option tables — `sed -i`, `sort -o`, `find -delete`, `git branch -D`, `curl
// -o` … are writers), a `clawket` call, or a verification command (build /
// test / lint / typecheck, whose writes are confined to regenerable outputs).
// Verification commands are allowed but recorded in hook.log so the audit
// trail shows what ran outside a task. Any command substitution, subshell,
// background job, `eval`/`exec`/`source`/`bash -c`, or write redirect other
// than /dev/null disqualifies the fast path.
function classifyBashFastPath(cmd, analysis) {
  const result = bashClassifier.classify(cmd, analysis);
  if (result.kind === 'verification') {
    appendHookLog({ event: 'verification_command', cmd: cmd.slice(0, 500), commands: result.commands });
  }
  return result;
}

function detectCliTarget() {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'win32') {
    throw new Error(
      'Windows is not yet supported by the Clawket CLI. ' +
        'Use WSL2 or macOS/Linux. Track: https://github.com/clawket/cli/issues'
    );
  }
  throw new Error(`Unsupported platform: ${platform}/${arch}`);
}

// HOOK-006: streaming download + SHA256 hashing. The hash is fed bytes as they
// arrive on the wire so we never have to re-read the file for verification —
// and, crucially, we can compare BEFORE renaming the .tmp into final position
// (downloadAndVerify does the commit-rename only after the hash matches).
//
// Returns the lowercase hex digest of the streamed bytes (when capture is
// enabled). Callers that do not need a digest pass captureHash=false to keep
// the original semantics.
function downloadToFileOnce(url, dest, captureHash) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const hasher = captureHash ? crypto.createHash('sha256') : null;
    const ca = resolveCaList();
    const opts = ca ? { ca } : {};
    // file.on('error') guards against ENOSPC and similar mid-stream write
    // failures. Without this, a partial write leaves a corrupted file behind
    // that downstream marker-version checks will treat as a successful install.
    file.on('error', (err) => {
      try { file.close(); } catch {}
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
    https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return downloadToFileOnce(res.headers.location, dest, captureHash).then(resolve, reject);
      }
      // GitHub rate-limit: 403 + X-RateLimit-Reset (Unix epoch seconds).
      // Surface a structured, actionable error so operators see when retry
      // becomes possible rather than a raw "HTTP 403" with no recovery path.
      if (res.statusCode === 403 && res.headers['x-ratelimit-reset']) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        const resetEpoch = parseInt(res.headers['x-ratelimit-reset'], 10);
        let resetIso = res.headers['x-ratelimit-reset'];
        if (!Number.isNaN(resetEpoch) && resetEpoch > 0) {
          try { resetIso = new Date(resetEpoch * 1000).toISOString(); } catch {}
        }
        const err = new Error(`github rate limit exceeded — try again after ${resetIso}`);
        err.statusCode = 403;
        err.rateLimited = true;
        err.resetAt = resetIso;
        return reject(err);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        const err = new Error(`HTTP ${res.statusCode} for ${url}`);
        err.statusCode = res.statusCode;
        return reject(err);
      }
      if (hasher) {
        res.on('data', (chunk) => { hasher.update(chunk); });
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        resolve(hasher ? hasher.digest('hex') : null);
      }));
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
//
// Returns the streamed-hash hex digest when opts.captureHash is true; null
// otherwise. Used by HOOK-006 to verify integrity before commit-rename.
async function downloadToFile(url, dest, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const captureHash = !!opts.captureHash;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await downloadToFileOnce(url, dest, captureHash);
    } catch (error) {
      lastError = error;
      const transient =
        (error.statusCode && error.statusCode >= 500 && error.statusCode < 600) ||
        ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED'].includes(error.code);
      if (!transient || attempt === maxAttempts) throw error;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      process.stderr.write(progressMsg('install.progress.transient_retry', {
        message: error.message, attempt, total: maxAttempts - 1, delay,
      }) + '\n');
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

// HOOK-111: marker writes are protected by a per-marker lockfile. Two
// concurrent setup processes can race on the same marker (e.g. two Claude
// Code windows opening simultaneously after a fresh `/plugin install`); the
// flock ensures the version file reflects a single, consistent install.
function writeInstalledVersion(markerPath, version) {
  const lockName = `clawket-marker-${path.basename(path.dirname(markerPath))}-${path.basename(markerPath)}.lock`;
  const lockFile = path.join(cacheDir(), lockName);
  let acquired = false;
  try {
    try { fs.mkdirSync(cacheDir(), { recursive: true }); } catch {}
    // Best-effort O_EXCL acquire — short critical section, no need to spin.
    try {
      const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      acquired = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Already locked: wait briefly, then proceed (zombie-safe — worst case
      // both processes write the same version).
      try { require('child_process').execSync('sleep 0.05'); } catch {}
    }
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${version}\n`);
  } catch (err) {
    process.stderr.write(`[clawket-setup] WARNING: failed to record version at ${markerPath}: ${err.message}\n`);
  } finally {
    if (acquired) { try { fs.unlinkSync(lockFile); } catch {} }
  }
}

// SHA256 verification — download integrity check.
//
// Strategy:
//   1. Fetch `SHA256SUMS` companion file from the same GitHub release.
//   2. Parse it (GNU sha256sum format: "<hex>  <filename>").
//   3. Compute SHA256 of the downloaded archive file.
//   4. Compare — mismatch → throw (hard failure, not a warning).
//
// CLAWKET_SKIP_SHA256=1 disables verification for air-gapped / corp proxy
// environments where the SHA256SUMS file itself may be blocked. This env var
// is documented in the setup guide; it must be set explicitly by the user.
async function fetchSha256Sums(repo, version) {
  const initialUrl = `https://github.com/${repo}/releases/download/${version}/SHA256SUMS`;
  const ca = resolveCaList();
  const opts = ca ? { ca } : {};
  const maxRedirects = 5;

  const fetchUrl = (url, redirectsLeft) => new Promise((resolve, reject) => {
    https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) {
          return reject(new Error(`SHA256SUMS fetch exceeded redirect limit at ${url}`));
        }
        // GitHub redirects to an absolute URL on release-assets.githubusercontent.com —
        // follow it verbatim instead of trying to remap to the original github.com host.
        const next = new URL(res.headers.location, url).toString();
        return fetchUrl(next, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode === 404) {
        process.stderr.write(`[clawket-setup] WARNING: SHA256SUMS not found for ${repo}@${version}. Skipping integrity check.\n`);
        return resolve(null);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`SHA256SUMS fetch failed: HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', (err) => {
      process.stderr.write(`[clawket-setup] WARNING: SHA256SUMS fetch network error (${err.message}). Skipping integrity check.\n`);
      resolve(null);
    });
  });

  return fetchUrl(initialUrl, maxRedirects);
}

function parseSha256Sums(content, filename) {
  if (!content) return null;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: "<hex>  <filename>" or "<hex> *<filename>"
    const match = trimmed.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && path.basename(match[2].trim()) === path.basename(filename)) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

function computeFileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

// HOOK-006: download → verify → atomic-rename pipeline. The final path on disk
// only ever appears AFTER the SHA256 check succeeds, so a corrupted/tampered
// archive can never be staged where downstream extract logic might read it.
//
// Order of operations:
//   1. Stream download into `destTmp` while computing SHA256 in-flight
//      (downloadToFile with captureHash=true returns the hex digest).
//   2. Fetch the published SHA256SUMS (best-effort: network failure or 404
//      degrades to "skip integrity check" with a warning, matching pre-HOOK-006
//      behavior — air-gapped / corp-proxy environments need this fallback).
//   3. Compare the streamed digest to the expected digest. Mismatch → unlink
//      tmp + throw.
//   4. Only after the comparison passes, atomically rename `destTmp` → `dest`.
//
// Per-artifact flock (cacheDir/clawket-<artifact>.lock) makes the rename safe
// against concurrent setups attempting to install the same artifact name.
async function downloadAndVerify(url, destTmp, dest, { repo, version, assetName }) {
  const lockName = `clawket-artifact-${path.basename(assetName)}.lock`;
  return await withArtifactLock(lockName, async () => {
    process.stderr.write(progressMsg('install.progress.downloading', {
      artifact: assetName,
    }) + '\n');
    const streamedHex = await downloadToFile(url, destTmp, { captureHash: true });

    const skip = process.env.CLAWKET_SKIP_SHA256 === '1';
    let expectedHex = null;
    if (!skip) {
      let sumsContent = null;
      try {
        sumsContent = await fetchSha256Sums(repo, version);
      } catch (err) {
        // Network error fetching SHA256SUMS: warn and continue (don't block install).
        process.stderr.write(progressMsg('install.progress.sha_fetch_warn', {
          message: err.message,
        }) + '\n');
      }
      if (sumsContent) {
        expectedHex = parseSha256Sums(sumsContent, assetName);
        if (!expectedHex) {
          // SHA256SUMS exists but asset not listed — warn (may be a partial release).
          process.stderr.write(progressMsg('install.progress.sha_asset_missing', {
            assetName,
          }) + '\n');
        }
      }
    } else {
      process.stderr.write(progressMsg('install.progress.sha_skipped', {}) + '\n');
    }

    if (expectedHex && streamedHex && streamedHex.toLowerCase() !== expectedHex.toLowerCase()) {
      try { fs.unlinkSync(destTmp); } catch {}
      throw new Error(
        `SHA256 mismatch for ${assetName}: expected ${expectedHex}, got ${streamedHex}. ` +
        `Download may be corrupted or tampered. Remove the file and retry. ` +
        `Set CLAWKET_SKIP_SHA256=1 to bypass (not recommended).`
      );
    }
    if (expectedHex) {
      process.stderr.write(progressMsg('install.progress.sha_ok', { assetName }) + '\n');
    }

    // HOOK-006 atomic commit: only here, AFTER verification, do we move the
    // tmp into final position. No callsite can observe a partially-verified
    // file at `dest`.
    fs.renameSync(destTmp, dest);
  });
}

// Per-artifact cross-process lock (HOOK-006/HOOK-111). Uses the same O_EXCL
// pattern as withInstallLock but lets us guard a single asset name. The lock
// lives in cacheDir() (XDG-compliant; survives plugin reinstall per LM-8).
async function withArtifactLock(lockName, fn) {
  const lockFile = path.join(cacheDir(), lockName);
  const maxWaitMs = 30_000;
  const startTs = Date.now();
  let acquired = false;
  while (Date.now() - startTs <= maxWaitMs) {
    try {
      const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Zombie recovery
      try {
        const pidStr = fs.readFileSync(lockFile, 'utf-8').trim();
        const pid = parseInt(pidStr, 10);
        if (!pid || isNaN(pid)) {
          try { fs.unlinkSync(lockFile); } catch {}
          continue;
        }
        try { process.kill(pid, 0); } catch (e) {
          if (e.code === 'ESRCH') {
            try { fs.unlinkSync(lockFile); } catch {}
            continue;
          }
        }
      } catch {}
      try { require('child_process').execSync('sleep 0.2'); } catch {}
    }
  }
  try {
    return await fn();
  } finally {
    if (acquired) { try { fs.unlinkSync(lockFile); } catch {} }
  }
}

// I18N-120: localized setup progress messages. We keep a minimal English
// fallback inline so the gate works even before the locale catalog loads (the
// catalog itself sits in `<pluginRoot>/locales/<locale>.json`). The CLAWKET_LOCALE
// env var is the primary input — see resolveLocale() for the full chain.
function progressMsg(key, vars) {
  // I18N-132: setup paths read CLAWKET_LOCALE explicitly so the chosen locale
  // is observable end-to-end. The t() helper already consults resolveLocale(),
  // which reads CLAWKET_LOCALE first; we surface the chosen value below.
  let msg = t(key, vars);
  if (msg === key) {
    // Fallback when locale catalog has not yet been populated with the new
    // I18N-120 keys (e.g. an older locale file in a partial install).
    const en = {
      'install.progress.downloading': '[clawket-setup] Downloading {artifact}...',
      'install.progress.sha_ok': '[clawket-setup] SHA256 OK for {assetName}',
      'install.progress.sha_skipped': '[clawket-setup] CLAWKET_SKIP_SHA256=1: skipping integrity check.',
      'install.progress.sha_fetch_warn': '[clawket-setup] WARNING: could not fetch SHA256SUMS: {message}. Proceeding without integrity check.',
      'install.progress.sha_asset_missing': '[clawket-setup] WARNING: {assetName} not found in SHA256SUMS. Skipping integrity check.',
      'install.progress.transient_retry': '[clawket-setup] transient {message} — retry {attempt}/{total} in {delay}ms',
      'install.progress.first_run': '[clawket-setup] First-run install (downloading binaries — this can take ~30s)',
      'install.progress.installed': '[clawket-setup] {component} {version} installed at {path}',
    };
    msg = en[key] || key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        msg = msg.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      }
    }
  }
  return msg;
}

// atomicCopyBin: copies src → dest.tmp then renames to dest (atomic on POSIX).
// Cleanup: dest.tmp is removed on any failure so a partially-written binary
// never masquerades as a valid installation on the next session start.
//
// macOS quarantine: GitHub-downloaded archives get the
// `com.apple.quarantine` xattr applied to extracted binaries on darwin,
// causing Gatekeeper prompts on first exec. We strip it best-effort after
// the rename — failures are swallowed because the worst case is a one-time
// dialog, not a broken install.
function atomicCopyBin(src, dest) {
  const tmp = `${dest}.tmp`;
  try {
    fs.copyFileSync(src, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
  if (os.platform() === 'darwin') {
    try {
      const { spawnSync } = require('child_process');
      spawnSync('xattr', ['-d', 'com.apple.quarantine', dest], { stdio: 'ignore' });
    } catch {}
  }
}

// atomicExtractDir: extracts archive into a staging directory (dest.staging),
// then renames it to dest. Ensures the final path is only visible once fully
// extracted — a partial extraction / interrupted process never yields a corrupt
// but existing directory that passes the version-marker check.
function atomicExtractDir(archive, destDir, extractFn) {
  const staging = `${destDir}.staging`;
  try {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(staging, { recursive: true });
    extractFn(staging);
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch {}
    fs.renameSync(staging, destDir);
  } catch (err) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    throw err;
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
  // HOOK-006: download → verify → atomic-rename happens inside downloadAndVerify.
  const archive = path.resolve(binDir, assetName);
  const archiveTmp = path.resolve(binDir, `${assetName}.tmp`);

  try {
    await downloadAndVerify(url, archiveTmp, archive, { repo: CLI_REPO, version: cliVersion, assetName });
  } catch (err) {
    try { fs.unlinkSync(archiveTmp); } catch {}
    throw err;
  }

  try {
    if (ext === 'tar.gz') {
      const extractDir = path.resolve(binDir, `clawket-${cliVersion}-${target}`);
      exec(`tar -xzf "${archive}" -C "${binDir}"`);
      const extracted = path.resolve(extractDir, 'clawket');
      if (fs.existsSync(extracted)) {
        atomicCopyBin(extracted, binPath);
      } else {
        throw new Error(`CLI binary not found after extract at ${extracted}`);
      }
    } else {
      exec(`cd "${binDir}" && unzip -o "${assetName}"`);
      const extracted = path.resolve(binDir, `clawket-${cliVersion}-${target}`, 'clawket.exe');
      if (fs.existsSync(extracted)) {
        atomicCopyBin(extracted, binPath);
      } else {
        throw new Error(`CLI binary not found after unzip at ${extracted}`);
      }
    }
  } finally {
    try { fs.unlinkSync(archive); } catch {}
  }
  writeInstalledVersion(markerPath, cliVersion);
  process.stderr.write(progressMsg('install.progress.installed', {
    component: 'CLI', version: cliVersion, path: binPath,
  }) + '\n');
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
  // HOOK-006: download → verify → atomic-rename happens inside downloadAndVerify.
  const archive = path.resolve(binDir, assetName);
  const archiveTmp = path.resolve(binDir, `${assetName}.tmp`);

  try {
    await downloadAndVerify(url, archiveTmp, archive, { repo: DAEMON_REPO, version: daemonVersion, assetName });
  } catch (err) {
    try { fs.unlinkSync(archiveTmp); } catch {}
    throw err;
  }

  try {
    if (ext === 'tar.gz') {
      const extractDir = path.resolve(binDir, `clawketd-${daemonVersion}-${target}`);
      exec(`tar -xzf "${archive}" -C "${binDir}"`);
      const extracted = path.resolve(extractDir, 'clawketd');
      if (fs.existsSync(extracted)) {
        atomicCopyBin(extracted, binPath);
      } else {
        throw new Error(`daemon binary not found after extract at ${extracted}`);
      }
    } else {
      exec(`cd "${binDir}" && unzip -o "${assetName}"`);
      const extracted = path.resolve(binDir, `clawketd-${daemonVersion}-${target}`, 'clawketd.exe');
      if (fs.existsSync(extracted)) {
        atomicCopyBin(extracted, binPath);
      } else {
        throw new Error(`daemon binary not found after unzip at ${extracted}`);
      }
    }
  } finally {
    try { fs.unlinkSync(archive); } catch {}
  }
  writeInstalledVersion(markerPath, daemonVersion);
  process.stderr.write(progressMsg('install.progress.installed', {
    component: 'daemon', version: daemonVersion, path: binPath,
  }) + '\n');
  return binPath;
}

async function ensureWebBundle(pluginRoot, version) {
  const webVersion = process.env.CLAWKET_WEB_VERSION || version;
  if (!webVersion) throw new Error('web version missing (components.json.web)');

  const webRoot = path.resolve(pluginRoot, 'web');
  const distDir = path.resolve(webRoot, 'dist');
  const indexFile = path.resolve(distDir, 'index.html');
  const markerPath = path.resolve(webRoot, '.clawket-version');

  if (fs.existsSync(indexFile) && readInstalledVersion(markerPath) === webVersion) {
    return webRoot;
  }
  if (fs.existsSync(indexFile)) {
    process.stderr.write(
      `[clawket-setup] web version mismatch (want ${webVersion}, have ${readInstalledVersion(markerPath) || 'unknown'}). Reinstalling.\n`
    );
    try { fs.rmSync(distDir, { recursive: true, force: true }); } catch {}
  }

  fs.mkdirSync(webRoot, { recursive: true });
  const assetName = `clawket-web-${webVersion}.tar.gz`;
  const url = `https://github.com/${WEB_REPO}/releases/download/${webVersion}/${assetName}`;
  // HOOK-006: download → verify → atomic-rename happens inside downloadAndVerify.
  const archive = path.resolve(webRoot, assetName);
  const archiveTmp = path.resolve(webRoot, `${assetName}.tmp`);

  try {
    await downloadAndVerify(url, archiveTmp, archive, { repo: WEB_REPO, version: webVersion, assetName });
  } catch (err) {
    try { fs.unlinkSync(archiveTmp); } catch {}
    throw err;
  }

  // Extract into a staging directory, then atomically rename to dist.
  try {
    atomicExtractDir(distDir, distDir, (staging) => {
      exec(`tar -xzf "${archive}" -C "${path.dirname(staging)}"`);
      // tar extracts to dist/ inside webRoot; move if staging path differs.
      const extractedDist = path.resolve(webRoot, 'dist');
      if (extractedDist !== staging && fs.existsSync(extractedDist)) {
        // tar already wrote to 'dist'; staging rename below handles atomicity.
        // We rename webRoot/dist → staging so atomicExtractDir can rename it back.
        fs.renameSync(extractedDist, staging);
      }
    });
  } finally {
    try { fs.unlinkSync(archive); } catch {}
  }

  if (!fs.existsSync(indexFile)) {
    throw new Error(`web bundle extracted but dist/index.html missing at ${indexFile}`);
  }
  writeInstalledVersion(markerPath, webVersion);
  process.stderr.write(progressMsg('install.progress.installed', {
    component: 'web', version: webVersion, path: webRoot,
  }) + '\n');
  return webRoot;
}

// Tauri desktop bundle. Unlike CLI/daemon (executables) and web (extracted
// bundle), the desktop artifact is a platform installer (.dmg / .msi /
// .AppImage) staged under `pluginRoot/desktop/dl/` for the user to run
// manually. The plugin tracks which version is "blessed" via the marker file
// but never invokes the installer — desktop install is a user action.
//
// `null` pin (the v3.0.0 sentinel; see `components.json#desktop`) is an
// explicit no-op: the desktop component is wired but not yet released, so
// any download attempt would 404. The skip preserves install-gate idempotency.
function desktopArtifactName(version) {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'darwin') {
    const target = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    return `clawket-desktop-${version}-${target}.dmg`;
  }
  if (platform === 'win32') {
    const target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    return `clawket-desktop-${version}-${target}.msi`;
  }
  // linux (and any other unix-like)
  const target = arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  return `clawket-desktop-${version}-${target}.AppImage`;
}

async function ensureDesktopBundle(pluginRoot, version) {
  const desktopVersion = process.env.CLAWKET_DESKTOP_VERSION || version;
  // null sentinel — desktop sub-repo / release does not yet exist. Skip
  // without writing a marker so the next session re-evaluates the pin.
  if (desktopVersion == null) return null;

  const desktopRoot = path.resolve(pluginRoot, 'desktop');
  const dlDir = path.resolve(desktopRoot, 'dl');
  const assetName = desktopArtifactName(desktopVersion);
  const artifactPath = path.resolve(dlDir, assetName);
  const markerPath = path.resolve(desktopRoot, '.clawket-version');

  if (fs.existsSync(artifactPath) && readInstalledVersion(markerPath) === desktopVersion) {
    return artifactPath;
  }
  if (fs.existsSync(artifactPath)) {
    process.stderr.write(
      `[clawket-setup] desktop version mismatch (want ${desktopVersion}, have ${readInstalledVersion(markerPath) || 'unknown'}). Redownloading.\n`
    );
    try { fs.unlinkSync(artifactPath); } catch {}
  }

  fs.mkdirSync(dlDir, { recursive: true });
  const url = `https://github.com/${DESKTOP_REPO}/releases/download/${desktopVersion}/${assetName}`;
  const archiveTmp = path.resolve(dlDir, `${assetName}.tmp`);

  try {
    await downloadAndVerify(url, archiveTmp, artifactPath, { repo: DESKTOP_REPO, version: desktopVersion, assetName });
  } catch (err) {
    try { fs.unlinkSync(archiveTmp); } catch {}
    throw err;
  }

  writeInstalledVersion(markerPath, desktopVersion);
  process.stderr.write(progressMsg('install.progress.installed', {
    component: 'desktop', version: desktopVersion, path: artifactPath,
  }) + '\n');
  return artifactPath;
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

// Install lock — prevents concurrent plugin setups from racing (e.g. two Claude
// Code windows opening simultaneously after a fresh `/plugin install`). Uses a
// PID file with O_EXCL for atomic creation. If the lock holder PID is no
// longer alive (zombie / crash), the stale lock is removed and we re-acquire.
//
// Lock file lives in cacheDir() which is XDG-compliant and survives plugin
// reinstalls (per CLAUDE.md path separation invariant LM-8). It does NOT live
// inside pluginRoot because that tree can be wiped by plugin reinstall.
function withInstallLock(fn) {
  const lockFile = path.join(cacheDir(), 'install.lock');
  const maxWaitMs = 30_000;
  const pollMs = 200;
  const startTs = Date.now();

  const tryAcquire = () => {
    // Attempt atomic creation: O_EXCL fails if file exists.
    try {
      const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return false;
    }
  };

  const releaseLock = () => {
    try { fs.unlinkSync(lockFile); } catch {}
  };

  const isZombie = () => {
    try {
      const pidStr = fs.readFileSync(lockFile, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);
      if (!pid || isNaN(pid)) return true; // malformed → treat as zombie
      // kill(pid, 0) throws ESRCH when the process does not exist.
      process.kill(pid, 0);
      return false;
    } catch (err) {
      // ESRCH = no such process (zombie lock), EPERM = exists but no permission
      return err.code === 'ESRCH';
    }
  };

  const acquire = () => {
    while (true) {
      if (tryAcquire()) return true;
      // Check for zombie lock and recover
      if (isZombie()) {
        process.stderr.write('[clawket-setup] Stale install lock detected (zombie PID). Recovering.\n');
        releaseLock();
        if (tryAcquire()) return true;
      }
      if (Date.now() - startTs > maxWaitMs) {
        process.stderr.write(`[clawket-setup] WARNING: install lock held for >${maxWaitMs}ms — proceeding without lock.\n`);
        return false;
      }
      // Synchronous poll (we're inside an async fn but cjs style requires sync here
      // because we cannot await in a non-async wrapper; use execSync for sleep).
      try { require('child_process').execSync(`sleep ${pollMs / 1000}`); } catch {}
    }
  };

  const locked = acquire();
  return fn().finally(() => {
    if (locked) releaseLock();
  });
}

// pingDaemonHealth: HTTP GET to /health on the local clawketd port. Returns
// true when the daemon answers 200 within the timeout. Used as the
// post-install order-of-operations gate so install markers are validated by
// observable daemon liveness rather than by file existence alone.
function pingDaemonHealth(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let port;
    try {
      const portFile = path.join(cacheDir(), 'clawketd.port');
      port = fs.readFileSync(portFile, 'utf-8').trim();
    } catch {
      return resolve(false);
    }
    if (!port) return resolve(false);
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        // Drain to release the socket promptly.
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode === 200));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(false); });
    req.end();
  });
}

// Idempotent install gate. plugin.json `setup` is not auto-executed by Claude
// Code (the field is not in the official plugin manifest schema), so the very
// first SessionStart after `/plugin install` must perform setup itself.
// Subsequent sessions are a no-op when version markers match — the cost of
// the gate is a few syscalls on the warm path.
//
// Returns `true` on success (already installed OR install completed AND
// daemon health confirmed), `false` on install failure. Callers (e.g.
// session-start.cjs) MUST honor the return value and skip context injection
// when `false` so a half-installed plugin does not produce confusing output.
// 3-way lock-step skill manifest. This array is the single source consumed by
// verifySkills(); plugin.json#skillsList and tests/skills-integrity.test.cjs
// each maintain their own copy by design (fail-loud invariant — see
// .claude/rules/skill-file-integrity-on-install.md). The cross-source equality
// is enforced by tests/skills-integrity.test.cjs which imports SKILLS_LIST
// via __test__ and asserts identity with the test-side SKILLS array and the
// plugin.json entries.
const SKILLS_LIST = [
  'clawket-dashboard',
  'clawket-plan-design',
  'clawket-scenario-author',
  'clawket-verify-batch',
  'clawket-verify-loop',
  'clawket-scenario-refine',
  'clawket-defect-fix',
];

/**
 * Verify the 7 skill SKILL.md/RULE.md files are intact. Returns true if all
 * 14 files exist (7 skills × 2 files); emits a stderr warning per missing
 * file and returns false otherwise. Called from ensureInstalled fast-path;
 * missing files trigger re-install.
 */
function verifySkills(pluginRoot) {
  let ok = true;
  for (const s of SKILLS_LIST) {
    for (const f of ['SKILL.md', 'RULE.md']) {
      const p = path.resolve(pluginRoot, 'skills', s, f);
      if (!fs.existsSync(p)) {
        process.stderr.write(`[clawket-setup] WARNING: missing ${path.relative(pluginRoot, p)} — partial install detected\n`);
        ok = false;
      }
    }
  }
  return ok;
}

async function ensureInstalled(pluginRoot) {
  let manifest;
  try {
    manifest = loadComponentsManifest(pluginRoot);
  } catch (err) {
    process.stderr.write(`[clawket-setup] WARNING: components.json missing or invalid: ${err.message}\n`);
    return false;
  }

  const cliBin = path.resolve(pluginRoot, 'bin', os.platform() === 'win32' ? 'clawket.exe' : 'clawket');
  const daemonBin = path.resolve(pluginRoot, 'daemon', 'bin', os.platform() === 'win32' ? 'clawketd.exe' : 'clawketd');
  const webIndex = path.resolve(pluginRoot, 'web', 'dist', 'index.html');
  const cliMarker = path.resolve(pluginRoot, 'bin', '.clawket-version');
  const daemonMarker = path.resolve(pluginRoot, 'daemon', 'bin', '.clawket-version');
  const webMarker = path.resolve(pluginRoot, 'web', '.clawket-version');
  const desktopMarker = path.resolve(pluginRoot, 'desktop', '.clawket-version');

  const cliOk = fs.existsSync(cliBin) && readInstalledVersion(cliMarker) === manifest.cli;
  const daemonOk = fs.existsSync(daemonBin) && readInstalledVersion(daemonMarker) === manifest.daemon;
  const webOk = fs.existsSync(webIndex) && readInstalledVersion(webMarker) === manifest.web;

  // Desktop component: `null` pin is the v3.0.0 sentinel (sub-repo + first
  // release not yet published). The skip MUST evaluate to true so the
  // fast-path AND-chain does not force a perpetual reinstall loop, but
  // MUST NOT write a marker (no install actually happened). When the pin
  // becomes a string tag, this collapses to the same marker check as the
  // other components.
  const desktopPin = manifest.desktop;
  const desktopOk = desktopPin == null
    ? true
    : fs.existsSync(path.resolve(pluginRoot, 'desktop', 'dl', desktopArtifactName(desktopPin)))
      && readInstalledVersion(desktopMarker) === desktopPin;

  // Verify the 7 skill SKILL.md + RULE.md files are present in the plugin
  // tree. A partial install (e.g. a release tarball that dropped the skills/
  // dir) should NOT be reported as healthy — the skill entrypoints would
  // otherwise resolve to nothing at runtime.
  const skillsOk = verifySkills(pluginRoot);

  if (cliOk && daemonOk && webOk && desktopOk && skillsOk) return true; // fast path — no lock needed

  process.stderr.write(progressMsg('install.progress.first_run', {}) + '\n');
  await withInstallLock(() => runSetup());

  // Order of operations (FIX-PLUGIN-014): install markers were already written
  // by ensureCliBinary/ensureDaemonBinary/ensureWebBundle. We now post-validate
  // the installation by booting the daemon and pinging /health. If health
  // fails we INVALIDATE the daemon marker so the next session retries the
  // install rather than trusting a binary that cannot serve requests.
  try {
    const { clawket } = runtime(pluginRoot);
    ensureDaemon(clawket, pluginRoot);
    const healthy = await pingDaemonHealth();
    if (!healthy) {
      process.stderr.write('[clawket-setup] daemon /health did not respond after install — invalidating marker so next session retries.\n');
      try { fs.unlinkSync(daemonMarker); } catch {}
      return false;
    }
  } catch (err) {
    process.stderr.write(`[clawket-setup] post-install daemon verification failed: ${err.message}\n`);
    try { fs.unlinkSync(daemonMarker); } catch {}
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// PDD Anti-pattern enforcement helpers (v3.0)
// X3: scenario_id NULL detection
// X7: batch size > 30 detection
// X8: evidence NULL detection
// X9: sync-code-with-reasoning detection
//
// Each helper:
//   - reads the relevant env-var mode (strict|warn|off, default=warn)
//   - calls getDaemonPort() / exec() — graceful skip if daemon is down
//   - writes a blocked-event line to ~/.cache/clawket/hook.log (XDG-safe, LM-8)
//   - returns { blocked: bool, reason: string }
// ---------------------------------------------------------------------------

/** Read daemon port from port file. Returns null when daemon is unavailable. */
function getDaemonPort() {
  try {
    const portFile = path.join(cacheDir(), 'clawketd.port');
    const port = fs.readFileSync(portFile, 'utf-8').trim();
    return port || null;
  } catch {
    return null;
  }
}

/**
 * Append a line to the hook log. Path resolution (XDG-compliant, LM-8 safe):
 *  - Default:  $XDG_STATE_HOME/clawket/hook.log    (or ~/.local/state/clawket/hook.log)
 *  - Override: CLAWKET_HOOK_LOG_DIR=<dir>          (CI / testing)
 *  - Fallback: cacheDir() + hook.log              (state dir not writable)
 *
 * v3.0 R2 fix (US-CKT-PROMOTE-029): hook.log is operational *state* (audit
 * trail of anti-pattern enforcement), so XDG-state is the correct
 * classification. v2 wrote to cache; cache is evictable without warning,
 * which defeats the audit-trail intent.
 *
 * Best-effort — never throws.
 */
function appendHookLog(entry) {
  try {
    const logDir = hookLogDir();
    fs.mkdirSync(logDir, { recursive: true });
    const line = JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n';
    fs.appendFileSync(path.join(logDir, 'hook.log'), line);
  } catch {}
}

/** Resolve the hook log directory (state-dir preferred, cache-dir fallback). */
function hookLogDir() {
  const override = process.env.CLAWKET_HOOK_LOG_DIR;
  if (override) return override;
  // Prefer XDG-state (audit trail must survive cache eviction).
  const xdgState = process.env.XDG_STATE_HOME
    ? path.join(process.env.XDG_STATE_HOME, 'clawket')
    : path.join(os.homedir(), '.local', 'state', 'clawket');
  try {
    fs.mkdirSync(xdgState, { recursive: true });
    return xdgState;
  } catch {
    return cacheDir();
  }
}

/**
 * v3.0 R2 fix (US-CKT-PROMOTE-030): centralised bypass audit gate.
 *
 * Returns true if CLAWKET_BYPASS_HOOKS=1. When bypass triggers, an audit-log
 * entry is emitted with the anti-pattern, context, uid, and env hints so
 * post-mortem can reconstruct who/when disabled enforcement.
 *
 * Note: we deliberately do *not* require root/euid privilege to set the
 * bypass. Running Claude Code as root is itself an anti-pattern; gating
 * bypass behind euid would push users toward `sudo`, which is worse than the
 * bypass it would prevent. The audit trail is the primary mitigation.
 */
function checkBypass(antiPattern, context) {
  if (process.env.CLAWKET_BYPASS_HOOKS !== '1') return false;
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    appendHookLog({
      anti_pattern: antiPattern,
      context,
      bypass: true,
      uid,
      env_user: process.env.USER || process.env.LOGNAME || null,
      ci: process.env.CI === '1' || process.env.CI === 'true' || false,
    });
  } catch {}
  return true;
}

/**
 * HOOK-001~010: X3 — scenario_id NULL / missing / bad-format check.
 *
 * mode env: CLAWKET_ENFORCE_SCENARIO_ID = strict | warn | off   (default warn)
 * bypass:   CLAWKET_BYPASS_HOOKS=1 skips all enforcement.
 *
 * @param {object} opts
 *   task        — task object (may have .scenario_id)
 *   scenarioId  — explicit scenario_id to validate (overrides task field)
 *   context     — 'post-tool-use' | 'pre-tool-use' | 'subagent-start'
 * @returns {{ blocked: boolean, reason: string }}
 */
function checkX3ScenarioId({ task, scenarioId, context } = {}) {
  if (checkBypass('X3', context || 'unknown')) return { blocked: false, reason: '' };

  // v3.0 R3 fix (US-CKT-HOOK-007): default = 'warn' (backward-compat).
  // R2 over-corrected to 'strict' to satisfy HOOK-006/018, but HOOK-006 only
  // requires that explicit env=strict triggers hard-fail — it does NOT
  // require the *default* be strict. HOOK-007 is explicit: "env unset →
  // exit code 0 + stderr warning". X3 (scenario_id) default differs from
  // X7/X8/X9 because scenario_id population is a v3.0 migration path; many
  // existing tasks lack it. Strict default would block ordinary task
  // creation. Explicit strict opt-in (CI) remains supported via env.
  const mode = (process.env.CLAWKET_ENFORCE_SCENARIO_ID || 'warn').toLowerCase();
  if (mode === 'off') return { blocked: false, reason: '' };

  // HOOK-010: graceful skip when daemon is unavailable
  if (!getDaemonPort()) {
    process.stderr.write('[clawket] daemon unavailable, skipping X3 check\n');
    return { blocked: false, reason: '' };
  }

  const sid = scenarioId || (task && task.scenario_id) || null;

  // HOOK-003: validate format when scenario_id is present
  if (sid) {
    const validFormat = /^US-[A-Z0-9][A-Z0-9_-]*-\d+$/i.test(sid);
    if (!validFormat) {
      const reason =
        `[Clawket] scenario_id format violation: "${sid}" does not match US-<DOMAIN>-<NNN>.\n` +
        `Fix: clawket task update <id> --scenario-id "US-<DOMAIN>-NNN"`;
      process.stderr.write(reason + '\n');
      appendHookLog({ anti_pattern: 'X3', context, mode, scenario_id: sid, violation: 'bad_format' });
      if (mode === 'strict') return { blocked: true, reason };
      return { blocked: false, reason };
    }
    // HOOK-004: valid scenario_id — no warning
    return { blocked: false, reason: '' };
  }

  // HOOK-001/002/009: scenario_id is NULL/missing
  const taskId = task ? (task.ticket_number || task.id || '?') : '?';
  const taskTitle = task ? (task.title || '') : '';
  const reason =
    `[Clawket] scenario_id is NULL for task ${taskId}${taskTitle ? ` — ${taskTitle}` : ''}. ` +
    `Every task must map to exactly 1 scenario (US-<DOMAIN>-<NNN>).\n` +
    `Fix: clawket task update <id> --scenario-id "US-<DOMAIN>-NNN"`;
  process.stderr.write(reason + '\n');
  appendHookLog({ anti_pattern: 'X3', context, mode, task_id: taskId, violation: 'null_scenario_id' });
  if (mode === 'strict') return { blocked: true, reason };  // HOOK-006
  return { blocked: false, reason };                         // HOOK-007 warn default
}

/**
 * HOOK-011~020: X7 — sub-agent batch size > 30 check.
 *
 * Counts unique "US-<DOMAIN>-<NNN>" IDs in the agent prompt.
 * mode env: CLAWKET_ENFORCE_BATCH = strict | warn | off   (default warn)
 *
 * @param {string} prompt — the sub-agent's prompt / tool input text
 * @returns {{ blocked: boolean, reason: string, count: number }}
 */
function checkX7BatchSize(prompt, opts = {}) {
  if (checkBypass('X7', opts.context || 'unknown')) return { blocked: false, reason: '', count: 0 };

  // v3.0 PDD A8: default = strict (auto-enforce > 30 → block). v2 was 'warn'.
  // R2 QA (US-CKT-HOOK-011, US-CKT-HOOK-018) flagged that warn default left
  // the 30/agent ceiling unenforced. opts.batchId is appended to the violation
  // message for traceability (US-CKT-HOOK-016).
  const mode = (process.env.CLAWKET_ENFORCE_BATCH || 'strict').toLowerCase();
  if (mode === 'off') return { blocked: false, reason: '', count: 0 };  // HOOK-016

  // HOOK-010-like: graceful skip when daemon is unavailable
  if (!getDaemonPort()) {
    process.stderr.write('[clawket] daemon unavailable, skipping X7 check\n');
    return { blocked: false, reason: '', count: 0 };
  }

  if (!prompt || typeof prompt !== 'string') return { blocked: false, reason: '', count: 0 };  // HOOK-020

  // HOOK-012: count unique scenario IDs matching US-<DOMAIN>-<NNN> pattern
  // HOOK-017: deduplicate (same scenario ID repeated counts once)
  // HOOK-018: non-US- patterns are ignored
  // HOOK-019: multi-domain counts are summed
  const matches = prompt.match(/\bUS-[A-Z0-9][A-Z0-9_-]*-\d+\b/gi) || [];
  const unique = new Set(matches.map((m) => m.toUpperCase()));
  const count = unique.size;

  if (count === 0) return { blocked: false, reason: '', count: 0 };  // HOOK-020

  // HOOK-013: exactly 30 passes
  if (count <= 30) return { blocked: false, reason: '', count };

  // HOOK-011/014/015/016/020: count > 30
  // Build explicit ID-range split guidance (US-CKT-HOOK-020): scan unique IDs
  // in the order they appear and emit "batch 1 (firstId ~ 30thId), batch 2 ..."
  // so the agent can see exactly where to split.
  const orderedUnique = [];
  const seen = new Set();
  for (const m of matches) {
    const up = m.toUpperCase();
    if (!seen.has(up)) { seen.add(up); orderedUnique.push(up); }
  }
  const splitLines = [];
  for (let i = 0; i < orderedUnique.length; i += 30) {
    const slice = orderedUnique.slice(i, i + 30);
    const idx = Math.floor(i / 30) + 1;
    splitLines.push(`  batch ${idx} (${slice[0]} ~ ${slice[slice.length - 1]}, ${slice.length} scenarios)`);
  }
  const batchIdSuffix = opts && opts.batchId ? ` [batch_id=${opts.batchId}]` : '';
  const reason =
    `[Clawket] Sub-agent batch size ${count} (limit 30) exceeds the batch ceiling.${batchIdSuffix} ` +
    `A batch larger than 30 risks attention degradation.\n` +
    `Fix: split into multiple sub-agent dispatches of ≤ 30 scenarios each.\n` +
    `split:\n${splitLines.join('\n')}`;
  process.stderr.write(reason + '\n');
  appendHookLog({ anti_pattern: 'X7', mode, batch_count: count, limit: 30, batch_id: opts && opts.batchId });
  if (mode === 'strict') return { blocked: true, reason, count };  // HOOK-014
  return { blocked: false, reason, count };                         // HOOK-015 warn default
}

const RUN_REF_RE = /\brun:(RUN-[A-Za-z0-9_-]+)/g;

function parseRunRefs(text) {
  return [...String(text || '').matchAll(RUN_REF_RE)].map((m) => m[1]);
}

// Any `run:<token>` makes the evidence a reference claim; a token that is not
// a run id (`run:undefined`, an unexpanded `run:${ID}`) must fail rather than
// pass as free text. Same rule as the daemon (repo::runs::cites_runs).
function citesRuns(text) {
  return /\brun:\S/.test(String(text || ''));
}

function malformedRunRef(text) {
  for (const m of String(text || '').matchAll(/\brun:(\S+)/g)) {
    if (!/^RUN-[A-Za-z0-9_-]+[.,;:)\]]*$/.test(m[1])) return m[1];
  }
  return null;
}

// Same predicate the daemon applies (repo::runs evidence validation): a run
// is evidence only once it finished and carries its full provenance.
function runRecordProblem(id, run) {
  if (!run) return `${id} does not exist`;
  const missing = ['command', 'input_hash', 'report_hash'].filter((k) => !(typeof run[k] === 'string' && run[k].trim()));
  if (typeof run.exit_code !== 'number') missing.push('exit_code');
  if (run.status !== 'finished') return `${id} is not finished (status=${run.status})`;
  if (missing.length) return `${id} is missing ${missing.join(', ')}`;
  return null;
}

function validateRunRefs(ids) {
  for (const id of ids) {
    const res = daemonGet(`/runs/${encodeURIComponent(id)}`);
    if (!res) return `daemon unreachable while resolving ${id}`;
    if (res.status === 404) return `${id} does not exist`;
    if (res.status !== 200 || !res.body) return `${id} could not be read (HTTP ${res.status})`;
    const problem = runRecordProblem(id, res.body);
    if (problem) return problem;
  }
  return null;
}

const TEST_CLAIM_RE = /\b(tests?|specs?|suites?|checks?|cargo test|pnpm test|npm test|vitest|jest|pytest|clippy|tsc|lint)\b[^.\n]{0,40}?\b(pass(?:ed|es|ing)?|green|succeed(?:ed|s)?|all ok)\b|\b\d+\s+(?:tests?\s+)?passed\b|\ball\s+green\b/i;

function isUnreferencedTestClaim(text) {
  return TEST_CLAIM_RE.test(String(text || '')) && parseRunRefs(text).length === 0;
}

/**
 * HOOK-021~030: X8 — evidence NULL / missing check.
 *
 * Fired when a task status transitions toward done/blocked/defect/scenario_error.
 * mode env: CLAWKET_ENFORCE_EVIDENCE = strict | warn | off   (default warn)
 *
 * @param {object} opts
 *   task     — task object (has .status, .evidence, .id, etc.)
 *   newStatus — the status being transitioned to ('done'|'blocked'|'cancelled'|...)
 * @returns {{ blocked: boolean, reason: string }}
 */
function checkX8Evidence({ task, newStatus } = {}) {
  if (checkBypass('X8', `task-update-${newStatus}`)) return { blocked: false, reason: '' };

  // v3.0 PDD T8: default = strict (auto-enforce). v2 was 'warn'.
  // R2 QA flagged that warn default left the evidence requirement
  // unenforced (US-CKT-HOOK-021/022/027/028). v3.0 reverses this: every
  // status transition that requires evidence is blocked unless caller
  // opts down via CLAWKET_ENFORCE_EVIDENCE=warn|off.
  const mode = (process.env.CLAWKET_ENFORCE_EVIDENCE || 'strict').toLowerCase();
  if (mode === 'off') return { blocked: false, reason: '' };

  // HOOK-010-like: graceful skip when daemon is unavailable
  if (!getDaemonPort()) {
    process.stderr.write('[clawket] daemon unavailable, skipping X8 check\n');
    return { blocked: false, reason: '' };
  }

  // HOOK-023 (v3.0 reversal): cancelled REQUIRES evidence to track the
  // scenario_error rationale — it is not exempt. v2 exempted cancelled which
  // contradicted PDD T8. The audit trail for "why was this scenario cancelled"
  // must be persisted on the task itself.
  // (cancelled now flows through the same NULL-check path below.)

  const evidence = task && (task.evidence || task.evidence_text || null);
  const MIN_EVIDENCE_CHARS = 16;  // US-CKT-HOOK-026 — block trivially short placeholders

  // HOOK-028: evidence length > 4096 bytes is itself a block
  if (evidence) {
    const evStr = String(evidence);
    const byteLen = Buffer.byteLength(evStr, 'utf8');
    if (byteLen > 4096) {
      const reason =
        `[Clawket] evidence field exceeds 4 KiB (${byteLen} bytes). ` +
        `Truncate to a concise file:line reference or reasoning summary.`;
      process.stderr.write(reason + '\n');
      appendHookLog({ anti_pattern: 'X8', mode, violation: 'evidence_too_large', bytes: byteLen });
      // 4 KiB violation is a hard block regardless of mode (corrupts audit trail)
      return { blocked: true, reason };
    }
    // Evidence by reference: `run:<RUN-ID>` points at a recorded verification
    // run (command, input hash, exit code, report hash). A reference is only
    // evidence if the run exists and is complete; the daemon re-validates on
    // write, this check gives the agent the reason before the round trip.
    const runRefs = parseRunRefs(evStr);
    if (citesRuns(evStr)) {
      const bad = malformedRunRef(evStr);
      const problem = bad ? `run:${bad} is not a run id (expected run:RUN-<id>)` : validateRunRefs(runRefs);
      if (problem) {
        const reason = `[Clawket] evidence reference invalid: ${problem}\n` +
          `Fix: record the verification with \`node "$CLAUDE_PLUGIN_ROOT/scripts/record-run.cjs" --task <TASK-ID> -- <command>\` and cite the printed run:<RUN-ID>.`;
        process.stderr.write(reason + '\n');
        appendHookLog({ anti_pattern: 'X8', mode, violation: 'evidence_run_invalid', refs: runRefs, problem });
        if (mode === 'strict') return { blocked: true, reason };
        return { blocked: false, reason };
      }
      return { blocked: false, reason: '' };
    }
    // A free-text claim that tests passed is not checkable. Test evidence must
    // cite the run that produced it; other free text (file:line, reasoning)
    // stays accepted.
    if (isUnreferencedTestClaim(evStr)) {
      const reason =
        `[Clawket] evidence claims a test/check result without a run reference ("${evStr.slice(0, 80)}").\n` +
        `Fix: record the run with \`node "$CLAUDE_PLUGIN_ROOT/scripts/record-run.cjs" --task <TASK-ID> -- <test command>\` and use --evidence "run:<RUN-ID>".`;
      process.stderr.write(reason + '\n');
      appendHookLog({ anti_pattern: 'X8', mode, violation: 'evidence_test_claim_unreferenced' });
      if (mode === 'strict') return { blocked: true, reason };
      return { blocked: false, reason };
    }
    // HOOK-026: minimum length check. Accept any string >= 16 chars OR any
    // file:line reference (path:digit) regardless of length, because compact
    // file:line refs can legitimately be shorter (e.g. "a.rs:9" is 6 chars but
    // is valid evidence). The 16-char floor blocks placeholder strings like
    // 'ok', 'tbd', 'done', etc.
    const isFileLineRef = /\S+:\d+/.test(evStr);
    if (evStr.trim().length < MIN_EVIDENCE_CHARS && !isFileLineRef) {
      const reason =
        `[Clawket] evidence is too short (${evStr.trim().length} chars, need >= ${MIN_EVIDENCE_CHARS} or file:line ref). ` +
        `Trivial placeholders defeat the audit trail.\n` +
        `Fix: use --evidence with file:line or summary (>=${MIN_EVIDENCE_CHARS} chars)`;
      process.stderr.write(reason + '\n');
      appendHookLog({ anti_pattern: 'X8', mode, violation: 'evidence_too_short', chars: evStr.trim().length });
      if (mode === 'strict') return { blocked: true, reason };
      return { blocked: false, reason };
    }
    return { blocked: false, reason: '' };  // HOOK-027: evidence present and adequate — pass
  }

  // Evidence is NULL/empty
  const taskId = task ? (task.ticket_number || task.id || '?') : '?';
  const isHardStatus = newStatus === 'done';   // HOOK-021/029/030
  const isCancelled = newStatus === 'cancelled';  // HOOK-023 v3.0 — also requires evidence
  const isWarnStatus = newStatus === 'blocked'; // HOOK-022

  let reason;
  if (isHardStatus || newStatus === 'defect' || newStatus === 'scenario_error' || isCancelled) {
    reason =
      `[Clawket] evidence is NULL for task ${taskId} transitioning to status="${newStatus}". ` +
      `All status transitions require evidence (file:line or reasoning summary).\n` +
      `Fix: use --evidence with file:line or summary (>=${MIN_EVIDENCE_CHARS} chars)`;
    process.stderr.write(reason + '\n');
    appendHookLog({ anti_pattern: 'X8', mode, task_id: taskId, new_status: newStatus, violation: 'null_evidence' });
    if (mode === 'strict') return { blocked: true, reason };  // HOOK-024
    return { blocked: false, reason };
  }

  // HOOK-022 (v3.0): blocked status now hard-fails in strict, matching the
  // PDD T8 contract. v2 always returned blocked:false ("warn only, never
  // hard-fail for blocked"); R2 QA flagged this as defect.
  if (isWarnStatus) {
    reason =
      `[Clawket] evidence is NULL for task ${taskId} transitioning to status="${newStatus}". ` +
      `Fix: use --evidence with file:line or summary (>=${MIN_EVIDENCE_CHARS} chars) — evidence required for blocked.`;
    process.stderr.write(reason + '\n');
    appendHookLog({ anti_pattern: 'X8', mode, task_id: taskId, new_status: newStatus, violation: 'null_evidence_blocked' });
    if (mode === 'strict') return { blocked: true, reason };
    return { blocked: false, reason };
  }

  return { blocked: false, reason: '' };
}

/**
 * HOOK-031~040: X9 — sync code with embedded reasoning detection.
 *
 * Heuristic: looks for Python scripts being executed via subprocess / shell
 * that contain reasoning-related keywords alongside DB update patterns.
 * Checked on Bash tool calls.
 *
 * mode env: CLAWKET_SYNC_CONTEXT marks an active bulk-sync block (e.g.
 *   "bulk-sync"), set by the sync driver itself. Enforcement requires this
 *   marker: without it the command surface is not scanned at all, so ordinary
 *   multi-update scripts and unrelated commands never false-positive (#52).
 *
 * @param {string} cmd — bash command string
 * @returns {{ blocked: boolean, reason: string }}
 */
function checkX9SyncReasoning(cmd, opts = {}) {
  if (checkBypass('X9', opts.toolName || 'unknown')) return { blocked: false, reason: '' };
  if (!cmd || typeof cmd !== 'string') return { blocked: false, reason: '' };

  // v3.0 PDD A8: 3-mode toggle CLAWKET_ENFORCE_SYNC_PURITY = strict | warn | off.
  // Default = strict (auto-enforce). v2 had no mode env at all and was warn-only.
  // R2 QA flagged this as defect (US-CKT-HOOK-038/039). Note this is a NEW env
  // var distinct from CLAWKET_SYNC_CONTEXT (which is a marker for the calling
  // sync block, not an enforcement mode).
  const mode = (process.env.CLAWKET_ENFORCE_SYNC_PURITY || 'strict').toLowerCase();
  if (mode === 'off') return { blocked: false, reason: '' };

  // HOOK-010-like: graceful skip when daemon is unavailable
  if (!getDaemonPort()) {
    process.stderr.write('[clawket] daemon unavailable, skipping X9 check\n');
    return { blocked: false, reason: '' };
  }

  // HOOK-031~035: Python script executing with sync patterns + reasoning words
  // Reasoning keywords that must NOT appear in bulk-sync code (US-CKT-HOOK-033:
  // status branches like "if x = pass; then status=done" must also trip even
  // without explicit reasoning vocabulary).
  const reasoningWords = /\b(reasoning|decide|classify|assess|evaluate|infer|determine|judge|conclude)\b/i;
  // Status-branch heuristic: bash/python/SQL conditional that maps an arbitrary
  // signal to a task status value. This covers transcription drivers that
  // sneak status decisions into the sync layer (US-CKT-HOOK-033).
  const statusBranch = /\b(if|elif|case|when|switch)\b[\s\S]{0,80}\bstatus\s*=\s*(?:'|"|\b)(done|blocked|cancelled|defect|scenario_error)\b/i;
  // Sync patterns: Python subprocess + DB/task update calls
  const syncPatterns = /\b(ThreadPoolExecutor|bulk_sync|task_update|status_update|clawket.*task.*update|UPDATE.*tasks\s+SET)/i;

  // HOOK-036~040: env CLAWKET_SYNC_CONTEXT triggers stricter check
  const syncContext = process.env.CLAWKET_SYNC_CONTEXT || '';
  // HOOK-036: ISO 8601 sync entry timestamp — generated lazily per call so the
  // remediation message can reference when the sync was last seen. Hook is
  // stateless across invocations; this stamps the moment the violation fires.
  const syncEntryTimestamp = new Date().toISOString();
  // HOOK-031/035: Agent tool invocations inside an active sync context are a
  // structural X9 violation: dispatching new reasoning while bulk sync is
  // running mixes layers (caller signals via opts.toolName='Agent' or by
  // putting 'Agent' / 'TeamCreate' in the cmd string).
  const looksLikeAgentInvocation =
    (opts && /^(Agent|TeamCreate|SendMessage)$/.test(opts.toolName || '')) ||
    /\b(?:Agent|TeamCreate|SendMessage)\s*\(/i.test(cmd) ||
    /\bsubagent\b/i.test(cmd);

  // #52: X9 only enforces inside an explicitly-marked bulk-sync block. Without
  // the CLAWKET_SYNC_CONTEXT marker we never scan the command surface, so an
  // ordinary script running many `clawket task update`s plus a human-readable
  // summary — or any unrelated command (even a `gh issue create` body) that
  // merely mentions "task update" / "TSV" / a reasoning word — cannot trip X9.
  // Every violation branch below sits inside an active sync context by construction.
  if (!syncContext) return { blocked: false, reason: '' };

  const looksLikeSync = syncPatterns.test(cmd);
  const containsReasoning = reasoningWords.test(cmd) || statusBranch.test(cmd);

  // HOOK-031/035: Agent invocation inside an active sync context. Block in
  // strict regardless of reasoning keywords because dispatching a new agent
  // while sync is in flight is itself the X9 layering violation.
  if (looksLikeAgentInvocation) {
    const reason =
      `[Clawket] Agent dispatch inside active sync context (${syncContext}, sync started at ${syncEntryTimestamp}). ` +
      `The sync layer must not invoke reasoning agents. ` +
      `Fix: complete bulk sync first, then dispatch new agent.`;
    process.stderr.write(reason + '\n');
    appendHookLog({ anti_pattern: 'X9', sync_context: syncContext, sync_entry_at: syncEntryTimestamp, violation: 'agent_in_sync' });
    if (mode === 'strict') return { blocked: true, reason };
    return { blocked: false, reason };
  }

  if (looksLikeSync && containsReasoning) {
    const reason =
      `[Clawket] Bulk-sync script appears to embed reasoning decisions ` +
      `(sync started at ${syncEntryTimestamp}). ` +
      `The sync layer must only transcribe TSV→DB (status mapping). ` +
      `Reasoning must happen in sub-agent dispatch step, not in the sync driver.\n` +
      `Fix: complete bulk sync first, then dispatch new agent.\n` +
      `Fix: move all status-decision logic to sub-agent TSV emit; sync only reads TSV.status.`;
    process.stderr.write(reason + '\n');
    appendHookLog({ anti_pattern: 'X9', cmd: cmd.slice(0, 200), sync_entry_at: syncEntryTimestamp, violation: 'reasoning_in_sync' });
    // v3.0 strict default: block (was warn-only in v2). HOOK-039.
    if (mode === 'strict') return { blocked: true, reason };
    return { blocked: false, reason };
  }

  // HOOK-040: explicit sync context with reasoning (no recognizable sync driver
  // shape, but reasoning keywords inside the marked sync block).
  if (containsReasoning) {
    const reason =
      `[Clawket] CLAWKET_SYNC_CONTEXT is set (${syncContext}, sync started at ${syncEntryTimestamp}) ` +
      `but command contains reasoning keywords. Sync context must not contain reasoning.\n` +
      `Fix: complete bulk sync first, then dispatch new agent.`;
    process.stderr.write(reason + '\n');
    appendHookLog({ anti_pattern: 'X9', sync_context: syncContext, sync_entry_at: syncEntryTimestamp, violation: 'reasoning_in_sync_context' });
    if (mode === 'strict') return { blocked: true, reason };
    return { blocked: false, reason };
  }

  return { blocked: false, reason: '' };
}

/**
 * HOOK-037: Best-effort cleanup of CLAWKET_SYNC_CONTEXT for the current process.
 * Bulk-sync drivers should call this immediately after the last bulk_sync DB
 * write so a subsequent agent dispatch from the same process is not classified
 * as X9 violation. Safe to call when the env is already unset.
 *
 * Note: Node cannot unset env on the parent shell. This guard only prevents
 * leak within the current Node process tree (and any child it spawns inherits
 * the cleared env). Caller code (the Python sync driver) must also clear the
 * var on the shell side; see plans/r3/sync-purity.md.
 */
function clearSyncContext() {
  if (process.env.CLAWKET_SYNC_CONTEXT) {
    delete process.env.CLAWKET_SYNC_CONTEXT;
    appendHookLog({ event: 'sync_context_cleared', at: new Date().toISOString() });
  }
}

// ---------------------------------------------------------------------------
// End of PDD anti-pattern helpers
// ---------------------------------------------------------------------------

/**
 * v3.0 R2 fix (US-CKT-PROMOTE-043): emit a v2→v3 migration notice on
 * SessionStart when the components manifest pins v3.0.0 but the on-disk
 * binaries are still v2.x. This is best-effort — never fatal.
 */
function checkV2ToV3Migration(pluginRoot) {
  try {
    const manifest = loadComponentsManifest(pluginRoot);
    if (!/^v?3\./.test(manifest.cli)) return;
    const cliMarker = path.resolve(pluginRoot, 'bin', '.clawket-version');
    const installed = readInstalledVersion(cliMarker);
    if (installed && /^v?2\./.test(installed)) {
      process.stderr.write(
        `[clawket] migration notice: components.json pins cli=${manifest.cli} but on-disk binary is ${installed}.\n` +
        `  This is a v2→v3 upgrade. Breaking changes: see clawket/docs/COMPATIBILITY.md (legacy MCP removed).\n` +
        `  Action: SessionStart will trigger ensureInstalled to download the v3 binaries.\n`
      );
    }
  } catch {}
}

async function runSessionStart() {
  recordHookEvent('SessionStart');
  try { ensureXdgDirs(); } catch {}
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  checkV2ToV3Migration(pluginRoot);
  // ensureInstalled throws on any component failure (FIX-PLUGIN-008). It also
  // returns `false` when install completed but the post-install daemon health
  // check failed (FIX-PLUGIN-014). We surface the error visibly but do NOT
  // exit non-zero — a session-start failure should not prevent Claude Code
  // from starting. When install fails we ABORT context injection (the
  // dashboard call is meaningless without a working daemon/CLI) and emit
  // only the install warning, so users get a clean actionable signal.
  let installError = null;
  let installOk = true;
  try {
    installOk = (await ensureInstalled(pluginRoot)) !== false;
  } catch (err) {
    installError = err;
    installOk = false;
    process.stderr.write(`[clawket] SETUP ERROR: ${err.message}\n`);
  }

  if (!installOk) {
    const message = installError
      ? `${t('install.setup_error', { message: installError.message })}`
      : t('install.aborted');
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `${t('hook.session_start.context')}\n\n${message}`,
      },
      systemMessage: t('install.warning_status'),
    }));
    process.exit(0);
  }

  const { clawket } = runtime(pluginRoot);
  ensureDaemon(clawket, pluginRoot);

  const cwd = process.env.HOOK_CWD || process.cwd();
  const context = exec(`${clawket} dashboard --cwd "${cwd}" --show active`);
  const rules = readPromptFiles(pluginRoot, ['prompts/shared/rules.md', 'prompts/claude/runtime.md']);
  const webUrl = getWebUrl();

  if (!context) {
    // No project registered for this cwd → SessionStart is a no-op.
    // Mirrors runUserPromptSubmit's `if (!context) allow()`: a directory that
    // is not a registered Clawket project should not have the plugin's
    // instruction context or onboarding guidance injected into the session.
    // Emit nothing (empty stdout = no additionalContext, no systemMessage)
    // rather than `{}`, sidestepping the SessionStart output schema entirely.
    // install/migration bootstrap above still runs regardless of membership.
    process.exit(0);
  }

  const summary = buildSummary(context);
  const statusLine = webUrl ? `Daemon: running Web: ${webUrl}` : 'Daemon: running';

  // HOOK-005: surface X3 risk in SessionStart context when active tasks lack scenario_id.
  // Best-effort: skip silently on parse failure.
  let x3RiskLine = '';
  try {
    const tasks = loadGateState(clawket, cwd, process.env.CLAUDE_SESSION_ID || '').inProgress;
    const x3Tasks = tasks.filter((tk) => !tk.scenario_id);
    if (x3Tasks.length > 0) {
      const ids = x3Tasks.map((tk) => tk.ticket_number || tk.id).join(', ');
      x3RiskLine = `\n\n[Clawket X3 risk] ${x3Tasks.length} in-progress task(s) missing scenario_id: ${ids}\n` +
        `Fix: clawket task update <id> --scenario-id "US-<DOMAIN>-NNN"`;
    }
  } catch {}

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `${t('hook.session_start.context')}\n\n${context}${x3RiskLine}` + (rules ? `\n\n${rules}` : ''),
    },
    systemMessage: `${summary}\n${statusLine}`,
  }));
}

function runUserPromptSubmit() {
  recordHookEvent('UserPromptSubmit');
  try { ensureXdgDirs(); } catch {}
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const cwd = hookInput.cwd || process.env.HOOK_CWD || process.cwd();
  if (isProjectDisabled(clawket, cwd)) allow();
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
      additionalContext: t('no_active_task_warning'),
    },
  }));
}

// ---------------------------------------------------------------------------
// PreToolUse gate state
//
// Everything the workflow gate needs comes from one daemon call,
// GET /gate/pre-tool-use?cwd=&session= (contract 1): the project resolved for
// cwd (with its enabled flag), the project's in_progress / blocked / assigned
// todo tasks, and its active plan / cycle counts. All task lookups are scoped
// to that project, so a task left in_progress in another project cannot
// satisfy this project's gate.
//
// Daemons that predate the endpoint (404, or no `contract` field) are served
// by `loadGateStateLegacy`, which reproduces the same state with the CLI in at
// most five calls and scopes tasks client-side by the project's ticket key.
// ---------------------------------------------------------------------------

const GATE_CONTRACT = 1;

/**
 * Sync GET against the daemon via curl (hooks run synchronously, so async
 * http is not usable). Returns `{ status, body }` with body parsed as JSON
 * (null when not JSON), or null when the daemon is unreachable.
 */
function daemonGet(pathname, { timeoutMs = 4000 } = {}) {
  const port = getDaemonPort();
  if (!port) return null;
  const args = ['-sS', '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))), '-w', '\n__HTTP__%{http_code}'];
  const token = getDaemonToken();
  if (token) args.push('-H', `X-Clawket-Token: ${token}`);
  args.push(`http://127.0.0.1:${port}${pathname}`);
  let out;
  try {
    out = execFileSync('curl', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs + 1000 });
  } catch {
    return null;
  }
  const splitIdx = out.lastIndexOf('\n__HTTP__');
  if (splitIdx < 0) return null;
  const status = parseInt(out.slice(splitIdx + 9), 10);
  let body = null;
  try { body = JSON.parse(out.slice(0, splitIdx)); } catch {}
  return { status, body };
}

function parseJsonArray(raw) {
  try {
    const v = JSON.parse(raw || '');
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function isEnabledFlag(v) {
  return !(v === 0 || v === false || v === '0');
}

function emptyGateState(source) {
  return {
    source,
    registered: false,
    project: null,
    enabled: true,
    inProgress: [],
    blockedIds: new Set(),
    todoAssigned: [],
    activePlans: null,
    activeCycles: null,
    sessionRun: null,
  };
}

function normalizeGateState(body) {
  const state = emptyGateState('endpoint');
  if (!body.project) return state;
  state.registered = true;
  state.project = body.project;
  state.enabled = isEnabledFlag(body.project.enabled);
  state.inProgress = Array.isArray(body.in_progress) ? body.in_progress : [];
  state.blockedIds = new Set(Array.isArray(body.blocked_ids) ? body.blocked_ids : []);
  state.todoAssigned = Array.isArray(body.todo_assigned) ? body.todo_assigned : [];
  state.activePlans = Number.isInteger(body.active_plan_count) ? body.active_plan_count : null;
  state.activeCycles = Number.isInteger(body.active_cycle_count) ? body.active_cycle_count : null;
  state.sessionRun = body.session_run || null;
  return state;
}

// Older daemons ignore `project_id` on GET /tasks, so the CLI's `--project`
// filter is silently global. Tasks carry no project id, but every task of a
// project with a key is numbered `<KEY>-<n>`; drop anything else (fail closed:
// a foreign task must never satisfy this project's gate).
function scopeTasksToProject(tasks, project) {
  if (!project || !project.key) return tasks;
  const prefix = `${project.key}-`;
  return tasks.filter((tk) => typeof tk.ticket_number === 'string' && tk.ticket_number.startsWith(prefix));
}

function loadGateStateLegacy(clawket, cwd) {
  const state = emptyGateState('legacy');
  let project = null;
  if (cwd) {
    try {
      const p = JSON.parse(exec(`${clawket} project resolve --cwd "${cwd}" --format json`) || 'null');
      if (p && typeof p === 'object' && typeof p.id === 'string') project = p;
    } catch {}
  }
  if (!project) {
    // Unregistered cwd or daemon unreachable: the dashboard is the
    // membership authority (it may resolve where `project resolve` cannot).
    if (!exec(`${clawket} dashboard --cwd "${cwd}" --show active`)) return state;
    process.stderr.write('[clawket] gate: project id unresolved for cwd; task lookups are not project-scoped\n');
  }
  state.registered = true;
  state.project = project;
  state.enabled = project ? isEnabledFlag(project.enabled) : true;
  if (!state.enabled) return state;

  const pf = project ? `--project "${project.id}" ` : '';
  let tasks = parseJsonArray(exec(`${clawket} task list ${pf}--status in_progress,blocked,todo --format json`)) || [];
  if (!tasks.some((tk) => tk.status === 'in_progress')) {
    // Daemons before v0.4.1 read a comma list as one unknown status.
    const ip = parseJsonArray(exec(`${clawket} task list ${pf}--status in_progress --format json`)) || [];
    tasks = tasks.concat(ip.filter((tk) => !tasks.some((x) => x.id === tk.id)));
  }
  tasks = scopeTasksToProject(tasks, project);
  state.inProgress = tasks.filter((tk) => tk.status === 'in_progress');
  state.blockedIds = new Set(tasks.filter((tk) => tk.status === 'blocked').map((tk) => tk.id));
  state.todoAssigned = tasks.filter((tk) => tk.status === 'todo' && tk.assignee);

  const plans = parseJsonArray(exec(`${clawket} plan list ${pf}--status active --format json`));
  state.activePlans = plans ? plans.length : null;
  const cyclesRaw = exec(`${clawket} cycle list ${pf}--status active --format json`);
  const cycles = parseJsonArray(cyclesRaw);
  state.activeCycles = cycles ? cycles.length : null;
  return state;
}

function loadGateState(clawket, cwd, sessionId) {
  const qs = `cwd=${encodeURIComponent(cwd || '')}` + (sessionId ? `&session=${encodeURIComponent(sessionId)}` : '');
  const res = daemonGet(`/gate/pre-tool-use?${qs}`);
  if (res && res.status === 200 && res.body && res.body.contract === GATE_CONTRACT) {
    return normalizeGateState(res.body);
  }
  return loadGateStateLegacy(clawket, cwd);
}

const AGENT_TOOLS = new Set(['Agent', 'TeamCreate', 'SendMessage']);
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit']);

function isHighTierModel(m) {
  if (!m) return false;
  if (/opus/.test(m)) return true;
  if (/sonnet.*4[-_]5|sonnet.*4[-_][6-9]|claude-4/.test(m)) return true;
  return false;
}

function isMedTierModel(m) {
  if (!m) return false;
  if (isHighTierModel(m)) return true;
  if (/sonnet/.test(m)) return true;
  if (/haiku.*3[-_]5|haiku.*3[-_][6-9]/.test(m)) return true;
  return false;
}

/**
 * Pure workflow-gate decision. No I/O and no state mutation — in particular
 * an Agent dispatch never promotes a todo task to in_progress; the caller
 * must start the task explicitly (`clawket task update <id> --status
 * in_progress`) before dispatching.
 *
 * @returns {{ decision: 'allow'|'deny', reason?: string, context?: string,
 *             agentBinding?: { name: string, task: object } }}
 */
function decideGate({ toolName, toolInput = {}, state, modelId = '' }) {
  if (!state.registered || !state.enabled) return { decision: 'allow' };
  const isAgent = AGENT_TOOLS.has(toolName);
  const agentName = isAgent ? (toolInput.name || '') : '';
  const todoForAgent = agentName ? state.todoAssigned.find((tk) => tk.assignee === agentName) : null;
  const startHint = (task) => t('gate.agent_task_not_started', {
    name: agentName,
    id: task.ticket_number || task.id,
  });

  if (state.inProgress.length === 0) {
    return { decision: 'deny', reason: todoForAgent ? startHint(todoForAgent) : t('gate.no_task') };
  }
  if (!state.activePlans) return { decision: 'deny', reason: t('gate.no_plan') };
  if (state.activeCycles === 0) return { decision: 'deny', reason: t('gate.no_cycle') };

  const runnable = state.inProgress.filter((tk) => !state.blockedIds.has(tk.id));
  if (runnable.length === 0) {
    const titles = state.inProgress.map((tk) => `  - [${tk.ticket_number || tk.id}] ${tk.title}`).join('\n');
    return { decision: 'deny', reason: `${t('gate.all_blocked')}\nBlocked tasks:\n${titles}` };
  }

  // PDD A4 (Task ⊂ Cycle ⊂ Unit): mutating tools need a cycle assignment.
  // Agent tools are exempt — the child tasks they create inherit the cycle.
  if (MUTATING_TOOLS.has(toolName)) {
    const noCycle = runnable.find((tk) => !tk.cycle_id);
    if (noCycle) {
      return {
        decision: 'deny',
        reason: `${t('gate.no_cycle_assignment')}\nTask: [${noCycle.ticket_number || noCycle.id}] ${noCycle.title}`,
      };
    }
  }

  if (agentName) {
    const task = runnable.find((tk) => tk.assignee === agentName);
    if (!task) {
      return {
        decision: 'deny',
        reason: todoForAgent ? startHint(todoForAgent) : t('gate.no_agent_task', { name: agentName }),
      };
    }
    return {
      decision: 'allow',
      context: `\n\n---\n[Clawket] 작업 티켓: ${task.ticket_number || task.id} — ${task.title}\nTask ID: ${task.id}`,
      agentBinding: { name: agentName, task },
    };
  }

  // FIX-PLUGIN-013 tier gate (low → any model; med → sonnet/haiku-3.5+;
  // high → opus / sonnet-4.5+). The session's own run picks the task when
  // known; otherwise the first runnable task.
  const sessionTask = state.sessionRun && runnable.find((tk) => tk.id === state.sessionRun.task_id);
  const task = sessionTask || runnable[0];
  const taskTier = task && task.tier ? String(task.tier).toLowerCase() : 'low';
  const model = String(modelId || '').toLowerCase();
  if (taskTier === 'high' && model && !isHighTierModel(model)) {
    return {
      decision: 'deny',
      reason:
        `Clawket Tier Gate: task tier=high but current model "${model}" is not a high-tier model.\n` +
        `High-tier tasks require claude-opus or claude-sonnet-4-5+ class models.\n` +
        `Switch to a high-tier model, or update the task tier: \`clawket task update ${task.id} --tier med\``,
    };
  }
  if (taskTier === 'med' && model && !isMedTierModel(model)) {
    return {
      decision: 'deny',
      reason:
        `Clawket Tier Gate: task tier=med but current model "${model}" is a low-tier model.\n` +
        `Med-tier tasks require at least claude-sonnet or claude-haiku-3-5+ class models.\n` +
        `Switch to a med-or-higher model, or update the task tier: \`clawket task update ${task.id} --tier low\``,
    };
  }
  const tierUsed = (task && (task.tier_used || task.tier)) || 'med';
  return { decision: 'allow', context: `CLAWKET_TIER_USED=${tierUsed}`, tierUsed: String(tierUsed) };
}

// Every PreToolUse deny goes out as the structured JSON decision with exit 0:
// Claude Code only reads the JSON on exit 0, and any other non-2 exit code is
// a non-blocking error that lets the tool call proceed.
function denyPreToolUse(reason) {
  process.stderr.write(`${reason}\n`);
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function runPreToolUse() {
  recordHookEvent('PreToolUse');
  try { ensureXdgDirs(); } catch {}
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

  if (readOnly.has(toolName)) allowPreToolUse();
  if (!AGENT_TOOLS.has(toolName) && !MUTATING_TOOLS.has(toolName) && !taskTools.has(toolName)) allowPreToolUse();

  if (toolName === 'Bash') {
    const cmd = (toolInput.command || '').trim();
    const analysis = bashClassifier.analyze(cmd);

    // Hard-block destructive commands BEFORE any auto-allow path so that
    // catalogued risks (e.g. `clawket plan delete --force`, `rm -rf` on user
    // data dirs) cannot slip through the clawket or read-only fast paths.
    // There is no bypass (v3, US-053): false positives are fixed in the
    // catalog, not unblocked locally.
    const matched = detectDestructive(cmd, pluginRoot, analysis);
    if (matched) {
      recordDestructiveBlock(matched, cmd);
      denyPreToolUse(t('destructive.blocked', {
        id: matched.id,
        category: matched.category,
        reason: matched.reason,
        remediation: matched.remediation,
      }));
    }

    // HOOK-031~040: X9 — bulk-sync scripts must not embed reasoning.
    {
      const x9 = checkX9SyncReasoning(cmd, { toolName: 'Bash' });
      if (x9.blocked) denyPreToolUse(x9.reason);
    }

    // HOOK-019: `clawket batch validate <prompt-file>` runs the X7 batch-size
    // check on the file contents at the hook layer.
    {
      const m = cmd.match(/^\s*clawket\s+batch\s+validate\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
      if (m) {
        const file = (m[1] ?? m[2] ?? m[3] ?? '').trim();
        if (file) {
          let promptText = '';
          try { promptText = fs.readFileSync(file, 'utf8'); } catch (e) {
            denyPreToolUse(`[Clawket] batch validate: cannot read prompt file "${file}" (${e.message}).`);
          }
          const x7File = checkX7BatchSize(promptText, { batchId: 'cli-batch-validate' });
          if (x7File.blocked) denyPreToolUse(x7File.reason);
          process.stderr.write(`[Clawket] batch validate ${file}: ${x7File.count}/30 scenarios — pass\n`);
        }
      }
    }

    // HOOK-002/003/006: X3 — scenario_id enforcement on Bash invocations of
    // `clawket task create` / `clawket task update`.
    if (/\bclawket\s+task\s+(?:create|update)\b/.test(cmd)) {
      const sidMatch = cmd.match(/--scenario-id(?:\s+|=)(?:"([^"]*)"|'([^']*)'|(\S+))/);
      const explicitSid = sidMatch ? (sidMatch[1] ?? sidMatch[2] ?? sidMatch[3] ?? '') : null;
      const isCreate = /\bclawket\s+task\s+create\b/.test(cmd);
      let x3 = null;
      if (explicitSid !== null && explicitSid !== '') {
        x3 = checkX3ScenarioId({ scenarioId: explicitSid, context: 'pre-tool-use-bash' });
      } else if (isCreate) {
        x3 = checkX3ScenarioId({ task: { id: 'create-cmd', title: '(new task)' }, context: 'pre-tool-use-bash' });
      }
      if (x3 && x3.blocked) denyPreToolUse(x3.reason);
    }

    const fast = classifyBashFastPath(cmd, analysis);
    if (fast.kind === 'readonly' || fast.kind === 'clawket' || fast.kind === 'verification') allowPreToolUse();
  }

  if (toolName === 'TaskUpdate') {
    // HOOK-003: X3 scenario_id format check.
    const sid = toolInput.scenario_id;
    if (sid !== undefined && sid !== null && sid !== '') {
      const x3 = checkX3ScenarioId({ scenarioId: sid, context: 'pre-tool-use' });
      if (x3.blocked) denyPreToolUse(x3.reason);
    }
    // HOOK-021/023: X8 — evidence on transitions that need an audit trail
    // (cancelled included: the cancellation reason is the scenario_error
    // refinement record).
    const newStatus = toolInput.status;
    if (newStatus && ['done', 'blocked', 'defect', 'scenario_error', 'cancelled'].includes(newStatus)) {
      const taskId = toolInput.id || toolInput.task_id || '';
      let taskObj = null;
      if (taskId) {
        try {
          const raw = exec(`${clawket} task view "${taskId}" --format json`);
          if (raw) taskObj = JSON.parse(raw);
        } catch {}
      }
      if (taskObj && toolInput.evidence) taskObj.evidence = toolInput.evidence;
      const x8 = checkX8Evidence({ task: taskObj || { id: taskId, evidence: toolInput.evidence || null }, newStatus });
      if (x8.blocked) denyPreToolUse(x8.reason);
    }
  }

  if (AGENT_TOOLS.has(toolName)) {
    // HOOK-031/035: X9 — Agent dispatch inside an active sync context.
    const promptForX9 = (toolInput.prompt || toolInput.message || '') + ' ' + JSON.stringify(toolInput).slice(0, 1000);
    const x9Agent = checkX9SyncReasoning(promptForX9, { toolName });
    if (x9Agent.blocked) denyPreToolUse(x9Agent.reason);
    // HOOK-011/016/018: X7 — ≤ 30 unique scenario IDs per dispatch.
    const promptText = toolInput.prompt || (toolInput.tool_input && toolInput.tool_input.prompt) || '';
    const x7 = checkX7BatchSize(promptText, { batchId: toolInput.batch_id || process.env.CLAWKET_BATCH_ID || '' });
    if (x7.blocked) denyPreToolUse(x7.reason);
  }

  const cwd = hookInput.cwd || process.env.HOOK_CWD || process.cwd();
  const sessionId = hookInput.session_id || process.env.CLAUDE_SESSION_ID || '';
  // Disabled projects bypass workflow enforcement but NOT the destructive
  // guard above, which protects user data regardless of Clawket policy.
  const state = loadGateState(clawket, cwd, sessionId);
  const modelId = process.env.CLAWKET_MODEL_ID || process.env.CLAUDE_CODE_MODEL_ID || process.env.CLAUDE_MODEL || '';
  const verdict = decideGate({ toolName, toolInput, state, modelId });
  if (verdict.decision === 'deny') denyPreToolUse(verdict.reason);

  if (verdict.agentBinding) {
    // SubagentStart binds the new sub-agent to this task through the pending
    // file (cache dir; plugin-owned transient state, not task state).
    const pendingFile = path.join(cacheDir(), 'agent-pending.json');
    const pending = readJson(pendingFile, []);
    pending.push({
      name: verdict.agentBinding.name,
      task_id: verdict.agentBinding.task.id,
      subagent_type: toolInput.subagent_type || 'general-purpose',
      ts: Date.now(),
    });
    writeJson(pendingFile, pending);
  }
  if (verdict.tierUsed) process.env.CLAWKET_TIER_USED = verdict.tierUsed;
  allowPreToolUse(verdict.context);
}

function runPostToolUse() {
  recordHookEvent('PostToolUse');
  try { ensureXdgDirs(); } catch {}
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

        // HOOK-001: X3 — warn when the active task has no scenario_id.
        // PostToolUse is the right place to check because by this point the
        // task is confirmed in_progress and a mutation just happened.
        // Daemon unavailability is handled inside checkX3ScenarioId.
        try {
          const taskRaw = exec(`${clawket} task view "${activeRun.task_id}" --format json`);
          if (taskRaw) {
            const taskObj = JSON.parse(taskRaw);
            checkX3ScenarioId({ task: taskObj, context: 'post-tool-use' });
          }
        } catch {}
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

        // HOOK-001: X3 — warn on in_progress tasks without scenario_id even
        // when there's no active run (best-effort, non-blocking).
        try {
          const cwd = hookInput.cwd || process.env.HOOK_CWD || process.cwd();
          const tasks = loadGateState(clawket, cwd, sessionId).inProgress;
          for (const tk of tasks) {
            checkX3ScenarioId({ task: tk, context: 'post-tool-use' });
          }
        } catch {}
      }
    } catch {}
  }
}

// LM-260 / L1.1.a — strict-mode gate.
//
// Validates Plan Mode markdown via daemon `/plans/import/strict` before
// surfacing it to Clawket. On 400 the hook prints the daemon's structured
// error (line/column/kind/hint) plus the canonical bypass guide. On 200
// we fall through to the existing "register this plan" guidance.
//
// Errors here are user-facing — the message text is the contract. Don't
// truncate the hint or hide the line/column; that's how the user finds the
// offending line in their plan.
function validateStrictPlan(_clawket, _cwd, content) {
  if (!content) return { ok: true, parsed: null };
  // Sync HTTP POST via curl. The hook is sync (Claude Code runs it via
  // execSync), so we cannot use the async `apiPost` helper here. The port
  // file is the single source of truth for daemon location (per LM-8 path
  // separation invariant — `cacheDir/clawketd.port`).
  let port;
  try {
    port = fs.readFileSync(path.join(cacheDir(), 'clawketd.port'), 'utf-8').trim();
  } catch {
    return { ok: false, networkError: true, reason: 'port file missing' };
  }
  if (!port) return { ok: false, networkError: true, reason: 'empty port file' };

  // Body uses raw stdin so the markdown isn't double-escaped through the
  // shell. We POST JSON via `--data @-` to avoid command-line length limits.
  const tmpFile = path.join(cacheDir(), `strict-import-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify({ content }), 'utf-8');
    const out = execDiag(
      `curl -sS -w '\\n__HTTP__%{http_code}' -X POST -H 'Content-Type: application/json' --data @${tmpFile} http://127.0.0.1:${port}/plans/import/strict`,
      { timeout: 5000 }
    );
    if (!out.ok || !out.stdout) return { ok: false, networkError: true };
    const splitIdx = out.stdout.lastIndexOf('\n__HTTP__');
    if (splitIdx < 0) return { ok: false, networkError: true, raw: out.stdout };
    const body = out.stdout.slice(0, splitIdx);
    const status = parseInt(out.stdout.slice(splitIdx + 9), 10);
    let resp;
    try { resp = JSON.parse(body); } catch { return { ok: false, networkError: true, raw: body }; }
    if (status >= 200 && status < 300) {
      return { ok: true, parsed: resp };
    }
    if (resp && resp.error === 'strict_format_violation' && resp.details) {
      return { ok: false, violation: resp.details };
    }
    return { ok: false, networkError: true, raw: body };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function strictGuideMessage(violation) {
  return [
    `# Clawket: Plan Mode 출력이 strict 포맷을 위반했습니다`,
    ``,
    `위반 위치: line ${violation.line}, column ${violation.column}`,
    `kind: ${violation.kind}`,
    `hint: ${violation.hint}`,
    ``,
    `다음 중 하나를 선택하세요:`,
    `1. 플랜 마크다운을 strict 포맷에 맞게 수정한다 (스펙: clawket/cli/docs/plans/strict-format.md).`,
    `2. 이 프로젝트에서 일시적으로 Clawket 강제를 끈다: \`clawket project disable <PROJ-...>\``,
    `   (활성화는 \`clawket project enable <PROJ-...>\` — destructive 가드는 그대로 작동합니다.)`,
  ].join('\n');
}

function runPlanSync() {
  recordHookEvent('ExitPlanMode');
  try { ensureXdgDirs(); } catch {}
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const cwd = hookInput.cwd || process.env.HOOK_CWD || process.cwd();

  // Disabled projects bypass the strict gate entirely (parity with the
  // rest of the hook surface — see isProjectDisabled docstring).
  if (isProjectDisabled(clawket, cwd)) allow();

  // Plan markdown can arrive two ways:
  //   (a) inline in the ExitPlanMode tool input (`hookInput.tool_input.plan`)
  //   (b) written to ~/.claude/plans/<title>.md by Claude Code
  // We prefer (a) — it's the canonical payload — and fall back to (b) for
  // older Claude Code versions that don't surface tool_input here.
  let content = '';
  let planFile = null;
  if (hookInput && hookInput.tool_input && typeof hookInput.tool_input.plan === 'string') {
    content = hookInput.tool_input.plan;
  } else {
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
    planFile = files[0].path;
    try { content = fs.readFileSync(planFile, 'utf-8'); } catch { content = ''; }
  }

  const result = validateStrictPlan(clawket, cwd, content);
  if (!result.ok && result.violation) {
    // Hard-block: emit decision=block so Claude sees the failure.
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: strictGuideMessage(result.violation),
      },
      decision: 'block',
      reason: `strict plan format violation at line ${result.violation.line}: ${result.violation.kind}`,
    }));
    process.exit(0);
  }

  // Auto-sync (FIX-PLUGIN-004): when the strict validator parsed the plan
  // successfully (result.ok && result.parsed), call `clawket plan create`
  // directly with the parsed plan body. This eliminates the manual 4-step
  // guide and makes ExitPlanMode a true auto-sync hook rather than a nudge.
  //
  // result.parsed shape (from /plans/import/strict 200 response):
  //   { id?, title, body, units: [{ title, scenarios, expected_cycles, mode }] }
  //
  // If result.parsed is not available (network error / daemon down / old strict
  // API version without parsed output), fall through to the legacy guide.
  if (result.ok && result.parsed && result.parsed.title) {
    const parsed = result.parsed;
    // Resolve project for this cwd.
    const projJson = exec(`${clawket} project resolve --cwd "${cwd}" --format json`);
    let projId = '';
    try { projId = JSON.parse(projJson || '{}').id || ''; } catch {}

    let autoSyncResult = null;
    if (projId) {
      // Write plan body to a temp file to avoid shell quoting issues with markdown.
      const bodyTmp = path.join(cacheDir(), `plan-body-${process.pid}-${Date.now()}.md`);
      try {
        fs.writeFileSync(bodyTmp, parsed.body || content, 'utf-8');
        const createOut = execDiag(
          `${clawket} plan create "${parsed.title.replace(/"/g, '\\"')}" --project "${projId}" --body-file "${bodyTmp}" --format json`
        );
        if (createOut.ok && createOut.stdout) {
          try { autoSyncResult = JSON.parse(createOut.stdout); } catch {}
        } else {
          process.stderr.write(`[clawket] plan auto-create failed: ${createOut.stderr}\n`);
        }
      } finally {
        try { fs.unlinkSync(bodyTmp); } catch {}
      }
    }

    if (autoSyncResult && autoSyncResult.id) {
      const planId = autoSyncResult.ticket_number || autoSyncResult.id;
      const unitsNote = parsed.units && parsed.units.length > 0
        ? `\n\n다음 Unit을 등록하세요 (\`clawket unit create\` — 자동 등록 미지원):\n` +
          parsed.units.map((u) => `  - ${u.title}`).join('\n')
        : '';
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            `# Clawket: Plan 자동 등록 완료\n\n` +
            `Plan ID: ${planId}\nTitle: ${parsed.title}${unitsNote}\n\n` +
            `Unit 등록 후 \`clawket cycle create --unit <UNIT-ID> --plan ${planId}\` 로 Cycle을 시작하세요.`,
        },
      }));
      return;
    }
  }

  // Network error / daemon down / auto-sync failed → fall through to the legacy
  // guide so we don't strand the user when auto-sync is unavailable.
  const fileNote = planFile ? `\nExitPlanMode로 승인된 플랜 파일: \`${planFile}\`\n` : '';
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `# Clawket: Plan Mode 종료 — 클라켓에 등록 필요
${fileNote}
이 플랜을 클라켓에 등록하세요:
1. \`clawket plan create "<title>" --project <PROJ-ID>\` 로 plan 생성
2. \`clawket unit create "<title>" --plan <PLAN-ID>\` — 각 Unit 등록
3. \`clawket cycle create --unit <UNIT-ID> --plan <PLAN-ID>\` — Cycle 시작
4. \`clawket task create "<title>" --cycle <CYCLE-ID> --unit <UNIT-ID>\` — 첫 Task 등록

플랜 내용을 Read해서 직접 파악하고, clawket CLI로 등록하세요.`,
    },
  }));
}

// runSubagentStart (FIX-PLUGIN-005): create a child task for this sub-agent
// under the active parent task, rather than relying on the pending-file
// matching heuristic (which races when multiple agents start in parallel).
//
// Flow:
//   1. Find the active parent task from agent-pending.json (written by PreToolUse).
//   2. Create a child task: `clawket task create --parent-task <ID> --type subagent`.
//   3. Start the child task in_progress and bind agent_id.
//   4. Inject parent task context into the sub-agent's system prompt.
//
// If no pending entry is found (e.g. the sub-agent was launched without a
// Clawket-registered parent), we gracefully skip — no orphan tasks created.
function runSubagentStart() {
  recordHookEvent('SubagentStart');
  try { ensureXdgDirs(); } catch {}
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const agentId = hookInput.agent_id || '';
  const agentType = hookInput.agent_type || 'general-purpose';
  if (!agentId) process.exit(0);

  // #56 part A: stand down on cwds clawket does not own. This hook previously
  // had NO cwd-ownership gate, so its X7/X9 denials and task-binding fired even
  // in projects owned by another work-management tool (e.g. SDI) or projects
  // the user explicitly disabled. Mirror the UserPromptSubmit/PreToolUse gates
  // (claude-hooks.cjs:1844, 2077-2080): a disabled project — or a cwd with no
  // active clawket project (empty dashboard) — is a graceful no-op.
  const cwd = hookInput.cwd || process.env.HOOK_CWD || process.cwd();
  if (isProjectDisabled(clawket, cwd)) process.exit(0);
  if (!exec(`${clawket} dashboard --cwd "${cwd}" --show active`)) process.exit(0);

  // HOOK-011~020: X7 — batch size check. Read scenario count from the agent's
  // prompt (hookInput.prompt or hookInput.tool_input.prompt). v3.0 default is
  // strict — block in strict mode (was warn-only in v2). batch_id is taken
  // from hookInput / env so the violation message can include it (HOOK-016).
  {
    const promptText = hookInput.prompt || (hookInput.tool_input && hookInput.tool_input.prompt) || '';
    const batchId = hookInput.batch_id || (hookInput.tool_input && hookInput.tool_input.batch_id) || process.env.CLAWKET_BATCH_ID || '';
    const x7 = checkX7BatchSize(promptText, { batchId });
    if (x7.blocked) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SubagentStart',
          permissionDecision: 'deny',
          permissionDecisionReason: x7.reason,
        },
      }));
      process.exit(0);
    }
  }

  // R3 DOGFOOD-030 fix: X9 — block sub-agent dispatch while a bulk sync is
  // in flight (CLAWKET_SYNC_CONTEXT set). PDD A8 layering: sync transcription
  // and sub-agent reasoning are distinct phases; dispatching reasoning during
  // sync is the X9 anti-pattern. Previously checked only on PreToolUse; the
  // SubagentStart event is the canonical hook to gate the actual launch.
  {
    const promptText = hookInput.prompt || (hookInput.tool_input && hookInput.tool_input.prompt) || '';
    // Synthesise a command-shape string so checkX9SyncReasoning's existing
    // looksLikeAgentInvocation heuristic fires. opts.toolName='Agent'
    // forces the agent-invocation branch regardless of prompt content.
    const x9 = checkX9SyncReasoning(`Agent(${agentType}) ${promptText.slice(0, 200)}`, {
      toolName: 'Agent',
    });
    if (x9.blocked) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SubagentStart',
          permissionDecision: 'deny',
          permissionDecisionReason: x9.reason,
        },
      }));
      process.exit(0);
    }
  }

  const pendingFile = path.join(cacheDir(), 'agent-pending.json');
  const pending = readJson(pendingFile, []);
  if (!pending.length) process.exit(0);

  // Match by agent_id first (set in PreToolUse when agent name is known),
  // then fall back to subagent_type for backward compatibility.
  let idx = pending.findIndex((entry) => entry.agent_id === agentId);
  if (idx === -1) {
    idx = pending.findIndex(
      (entry) => (entry.subagent_type || 'general-purpose') === (agentType || 'general-purpose')
    );
  }
  if (idx === -1) process.exit(0);
  const matched = pending.splice(idx, 1)[0];
  if (pending.length) writeJson(pendingFile, pending);
  else { try { fs.unlinkSync(pendingFile); } catch {} }

  const parentTaskId = matched.task_id;

  // Fetch parent task for context injection.
  let parentTask = null;
  try {
    const raw = exec(`${clawket} task view "${parentTaskId}" --format json`);
    if (raw) parentTask = JSON.parse(raw);
  } catch {}

  // HOOK-009: X3 — warn when binding task has no scenario_id.
  if (parentTask) {
    checkX3ScenarioId({ task: parentTask, context: 'subagent-start' });
  }

  // Create child task for this sub-agent under the parent.
  const childTitle = `[subagent:${agentType}] ${parentTask ? parentTask.title : parentTaskId}`;
  const childJson = execDiag(
    `${clawket} task create "${childTitle.replace(/"/g, '\\"')}" --parent-task "${parentTaskId}" --type subagent --status in_progress --format json`
  );
  let childTask = null;
  if (childJson.ok && childJson.stdout) {
    try { childTask = JSON.parse(childJson.stdout); } catch {}
  }

  if (childTask && childTask.id) {
    // Bind agent_id to the child task.
    exec(`${clawket} task update "${childTask.id}" --agent-id "${agentId}"`);
    // HOOK-045: append a "sub-agent <ID> started" comment line to the child
    // task body so the trail is visible even if the agent_id column is later
    // overwritten. This is structural — column-level binding alone left no
    // human-readable trace at start time.
    const startTs = new Date().toISOString();
    const startNote = `\n[SubagentStart ${startTs}] sub-agent ${agentId} started (type=${agentType}, parent=${parentTaskId})`;
    exec(`${clawket} task append-body "${childTask.id}" --text "${startNote.replace(/"/g, '\\"')}"`);
  } else {
    // Fallback: bind agent_id to the parent task (v2 behavior).
    exec(`${clawket} task update "${parentTaskId}" --agent-id "${agentId}"`);
    // HOOK-045: append start trail to parent task in the fallback path too.
    const startTs = new Date().toISOString();
    const startNote = `\n[SubagentStart ${startTs}] sub-agent ${agentId} started (type=${agentType})`;
    exec(`${clawket} task append-body "${parentTaskId}" --text "${startNote.replace(/"/g, '\\"')}"`);
  }

  // Inject parent context into the sub-agent, including X3/X7 guidance.
  let pddWarnings = '';
  const x7Check = checkX7BatchSize(hookInput.prompt || '');
  if (x7Check.count > 0 && x7Check.count <= 30) {
    // Informational: batch count within limit.
    pddWarnings += `\n[Clawket PDD] Batch size: ${x7Check.count}/30 scenarios.`;
  }
  if (parentTask && !parentTask.scenario_id) {
    pddWarnings += `\n[Clawket X3 risk] Parent task has no scenario_id — set one before marking done.`;
  }

  const parentCtx = parentTask
    ? `[Clawket] Parent task: ${parentTask.ticket_number || parentTaskId} — ${parentTask.title}` +
      (parentTask.body ? `\nScope: ${parentTask.body.slice(0, 300)}` : '') +
      pddWarnings
    : `[Clawket] Parent task ID: ${parentTaskId}${pddWarnings}`;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SubagentStart',
      additionalContext: parentCtx,
    },
  }));
}

function runSubagentStop() {
  recordHookEvent('SubagentStop');
  try { ensureXdgDirs(); } catch {}
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const agentId = hookInput.agent_id || '';
  if (!agentId) process.exit(0);

  // HOOK-044: daemon-availability gate. All cleanup paths below issue
  // `clawket task list/view/update` calls; without daemon they fail silently
  // through the swallowed try/catch and leak the in_progress child task. We
  // explicitly surface the skip reason so the user sees actionable feedback.
  if (!getDaemonPort()) {
    process.stderr.write('[clawket SubagentStop] daemon unavailable, skipping cleanup\n');
    appendHookLog({ event: 'SubagentStop', skipped: 'daemon_unavailable', agent_id: agentId });
    process.exit(0);
  }

  // Find ALL in_progress tasks bound to this agent_id (created in
  // runSubagentStart). R3 fix (US-CKT-HOOK-041): iterate every bound task,
  // not just the first. Previously `tasks.find((t) => t.type === 'subagent')
  // || tasks[0]` processed exactly one task, so multi-task-per-agent leaks
  // (LM-76 case) could still occur when an agent legitimately owned more
  // than one in_progress task at shutdown.
  let tasks = [];
  try { tasks = JSON.parse(exec(`${clawket} task list --status in_progress --agent-id "${agentId}"`) || '[]'); } catch {}
  if (!tasks.length) {
    // Even with no bound tasks, clear sync context (R3 HOOK-037) so a
    // subsequent agent dispatch from this Node process tree is not
    // misclassified as X9 violation.
    clearSyncContext();
    process.exit(0);
  }

  // Prefer child tasks (type=subagent) first for stable ordering, then any
  // remaining in_progress tasks (backward compat with pre-FIX-PLUGIN-005
  // parent task binding). All entries in `tasks` are processed.
  const childTasks = tasks
    .slice()
    .sort((a, b) => (a.type === 'subagent' ? -1 : 0) - (b.type === 'subagent' ? -1 : 0));

  // HOOK-043: shared 4 KiB cap (UTF-8 byte boundary) for the result summary
  // appended to every bound task. Computed once outside the loop.
  const lastMsg = hookInput.last_assistant_message || '';
  const MAX_BODY_BYTES = 4096;
  let summary = lastMsg;
  if (Buffer.byteLength(summary, 'utf8') > MAX_BODY_BYTES) {
    let buf = Buffer.from(summary, 'utf8').slice(0, MAX_BODY_BYTES);
    while (buf.length > 0) {
      try { buf.toString('utf8'); break; } catch { buf = buf.slice(0, -1); }
    }
    summary = buf.toString('utf8') + '... [truncated to 4 KiB]';
  }
  const tierUsed = process.env.CLAWKET_TIER_USED || '';

  for (const childTask of childTasks) {
    // HOOK-042: append the result summary using the scenario-required wording
    // "sub-agent <ID> result: <summary>". Previous "[SubagentStop] <summary>"
    // prefix did not embed agent_id and failed the spec.
    if (summary) {
      const line = `\nsub-agent ${agentId} result: ${summary.replace(/"/g, '\\"')}`;
      exec(`${clawket} task append-body "${childTask.id}" --text "${line}"`);
    }

    // HOOK-026/044: X8 — auto-fill evidence from last_assistant_message if
    // the task has no evidence yet. Best-effort evidence trail before done.
    try {
      const taskRaw = exec(`${clawket} task view "${childTask.id}" --format json`);
      const taskObj = taskRaw ? JSON.parse(taskRaw) : null;
      if (taskObj && !taskObj.evidence && summary) {
        const autoEvidence = Buffer.byteLength(summary, 'utf8') > 512
          ? Buffer.from(summary, 'utf8').slice(0, 512).toString('utf8') + '...'
          : summary;
        exec(`${clawket} task update "${childTask.id}" --evidence ${JSON.stringify(autoEvidence)}`);
      }
      // HOOK-045: auto-fill tier_used from CLAWKET_TIER_USED env.
      if (tierUsed && taskObj && !taskObj.tier_used) {
        exec(`${clawket} task update "${childTask.id}" --tier-used ${JSON.stringify(tierUsed)}`);
      }
    } catch {}

    // HOOK-021: X8 — final evidence check before marking done.
    let finalTask = null;
    try {
      const raw = exec(`${clawket} task view "${childTask.id}" --format json`);
      if (raw) finalTask = JSON.parse(raw);
    } catch {}
    const x8 = checkX8Evidence({ task: finalTask || childTask, newStatus: 'done' });
    if (x8.blocked) {
      // Hard-block per task: leave this one in_progress, continue with the rest.
      process.stderr.write(
        `[Clawket SubagentStop] Cannot auto-complete task ${childTask.id} — ${x8.reason}\n` +
        `Task left in_progress. Fix: clawket task update ${childTask.id} --evidence "path/to/file:line"\n`
      );
      appendHookLog({ event: 'SubagentStop', anti_pattern: 'X8', task_id: childTask.id, blocked: true });
      continue;
    }

    exec(`${clawket} task update "${childTask.id}" --status done --comment "자동 완료: 에이전트 종료 (agent_id: ${agentId})"`);
  }

  // R3 fix (US-CKT-HOOK-037): auto-clear CLAWKET_SYNC_CONTEXT at the end of
  // SubagentStop so a subsequent agent dispatch from the same Node process
  // tree is not misclassified as X9 violation. Caller-cooperation comment
  // on clearSyncContext still applies for the parent shell, but the hook
  // itself no longer leaks the var to child processes it spawns.
  clearSyncContext();
}

// ---------------------------------------------------------------------------
// Stop-hook auto-advance (migration 027 / GET /continuation).
//
// Helpers below are pure / side-effect-scoped so they can be unit-tested in
// isolation (see __test__ exports) without a live daemon.
// ---------------------------------------------------------------------------

/** Read the daemon TCP auth token (cacheDir/clawketd.token). Null when absent. */
function getDaemonToken() {
  try {
    const tok = fs.readFileSync(path.join(cacheDir(), 'clawketd.token'), 'utf-8').trim();
    return tok || null;
  } catch {
    return null;
  }
}

/** Marker file recording the last step id we injected for a session. */
function continuationMarkerPath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(cacheDir(), `continuation-${safe}.json`);
}

/**
 * Sync GET /continuation?cwd=<cwd> through daemonGet. Returns the parsed JSON body, or null on any
 * network/parse error (caller MUST treat null as "allow stop" — never block
 * the agent because the daemon was unreachable).
 */
function fetchContinuation(cwd) {
  const res = daemonGet(`/continuation?cwd=${encodeURIComponent(cwd || '')}`);
  if (!res || !(res.status >= 200 && res.status < 300)) return null;
  return res.body;
}

/**
 * Pure decision core for the Stop hook. Given the continuation response and the
 * marker state, decide whether to block (inject) or allow the stop, and what
 * the new marker should be. Side-effect free for testability.
 *
 * @param {object} input
 * @param {object|null} input.continuation  parsed /continuation body, or null
 * @param {string|null} input.lastStepId    step id injected on the prior turn
 * @param {boolean} input.stopHookActive    Claude Code `stop_hook_active` flag
 * @returns {{ block: boolean, reason?: string, marker: string|null }}
 *   block=true  → emit {decision:"block", reason}; marker is the new step id.
 *   block=false → allow stop; marker=null means clear the marker file.
 */
function decideContinuation({ continuation, lastStepId, stopHookActive }) {
  // Daemon down / malformed / opt-out / plan complete → allow stop, clear marker.
  if (!continuation || !continuation.next || !continuation.next.id) {
    return { block: false, marker: null };
  }
  const next = continuation.next;
  const instruction = continuation.instruction || `다음 작업을 진행하라: ${next.id}`;

  // Progress guard: if the next actionable step is identical to what we already
  // injected, the agent did not make progress on it — allow the stop to avoid an
  // infinite re-injection loop. `stop_hook_active` (Claude is re-entering the
  // Stop hook after a prior block) on the same step is the definitive signal.
  if (lastStepId && next.id === lastStepId) {
    return { block: false, marker: lastStepId };
  }
  if (stopHookActive && lastStepId && next.id === lastStepId) {
    return { block: false, marker: lastStepId };
  }

  // First injection or a genuinely new step → block + inject.
  return { block: true, reason: instruction, marker: next.id };
}

function runStop() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);

  const hookInput = readHookInput();
  const sessionId = hookInput.session_id || process.env.CLAUDE_SESSION_ID || '';
  const cwd = hookInput.cwd || process.env.HOOK_CWD || process.cwd();
  const stopHookActive = hookInput.stop_hook_active === true;

  // ---- 1. Preserve legacy run cleanup (auto-close open runs for the session).
  if (sessionId) {
    try {
      const runs = JSON.parse(exec(`${clawket} run list --session-id "${sessionId}"`) || '[]');
      for (const run of runs) {
        if (!run.ended_at) exec(`${clawket} run finish "${run.id}" --result session_ended --notes "Auto-closed by Stop hook"`);
      }
    } catch {}
  }

  // ---- 2. Circuit breaker: explicit opt-out always allows the stop.
  if (process.env.CLAWKET_NO_AUTO_ADVANCE === '1') process.exit(0);

  // ---- 3. Auto-advance decision.
  const markerFile = continuationMarkerPath(sessionId);
  let lastStepId = null;
  try {
    lastStepId = (readJson(markerFile, {}) || {}).stepId || null;
  } catch { lastStepId = null; }

  const continuation = fetchContinuation(cwd);
  const decision = decideContinuation({ continuation, lastStepId, stopHookActive });

  if (decision.block) {
    try { writeJson(markerFile, { stepId: decision.marker, ts: Date.now() }); } catch {}
    process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.reason }));
    process.exit(0);
  }

  // Allow stop. Clear the marker when the plan is done / opted-out so the next
  // active plan starts from a clean slate.
  if (decision.marker === null) {
    try { fs.unlinkSync(markerFile); } catch {}
  }
  process.exit(0);
}

// runSetup: attempt all three component installs and then throw an aggregate
// error if any failed. "Attempt all" means a CLI success still lets the daemon
// and web bundle be tried — maximising what gets installed on a flaky network.
// The aggregate throw propagates to the caller (ensureInstalled → withInstallLock
// → runSessionStart), which surfaces a visible, actionable error instead of
// silently proceeding with a broken installation. The CLI hint is appended to
// each individual error so users know the manual bypass path.
async function runSetup() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  ensureXdgDirs();
  const manifest = loadComponentsManifest(pluginRoot);

  const failures = [];

  try {
    await ensureCliBinary(pluginRoot, manifest.cli);
  } catch (error) {
    const hint = `Hint: place a clawket binary at ${path.resolve(pluginRoot, 'bin', 'clawket')} manually, or rerun setup with CLAWKET_CLI_VERSION override.`;
    process.stderr.write(`[clawket-setup] CLI binary install failed: ${error.message}\n[clawket-setup] ${hint}\n`);
    failures.push(new Error(`CLI: ${error.message}`));
  }

  try {
    await ensureDaemonBinary(pluginRoot, manifest.daemon);
  } catch (error) {
    const hint = `Hint: place a clawketd binary at ${path.resolve(pluginRoot, 'daemon', 'bin', 'clawketd')} manually, or rerun setup with CLAWKET_DAEMON_VERSION override.`;
    process.stderr.write(`[clawket-setup] daemon binary install failed: ${error.message}\n[clawket-setup] ${hint}\n`);
    failures.push(new Error(`daemon: ${error.message}`));
  }

  try {
    await ensureWebBundle(pluginRoot, manifest.web);
  } catch (error) {
    const hint = `Hint: extract clawket-web-<version>.tar.gz into ${path.resolve(pluginRoot, 'web')} manually, or rerun setup with CLAWKET_WEB_VERSION override.`;
    process.stderr.write(`[clawket-setup] web bundle install failed: ${error.message}\n[clawket-setup] ${hint}\n`);
    failures.push(new Error(`web: ${error.message}`));
  }

  // Desktop bundle — `null` pin is a no-op skip (v3.0.0 sentinel). When the
  // pin is a string tag, a download failure is non-fatal: the desktop app is
  // an optional companion (CLI/daemon/web carry the full plugin contract),
  // so we record the failure for visibility without blocking the install.
  try {
    await ensureDesktopBundle(pluginRoot, manifest.desktop);
  } catch (error) {
    const hint = `Hint: download the desktop installer from https://github.com/${DESKTOP_REPO}/releases manually, or rerun setup with CLAWKET_DESKTOP_VERSION override.`;
    process.stderr.write(`[clawket-setup] desktop bundle install failed: ${error.message}\n[clawket-setup] ${hint}\n`);
    failures.push(new Error(`desktop: ${error.message}`));
  }

  linkCliToUserBin(pluginRoot);
  // Node's default https Agent keeps download sockets alive past completion,
  // which prevents natural event-loop exit. Destroy the pool explicitly so
  // Claude Code's install hook does not block on the plugin.
  try { https.globalAgent.destroy(); } catch {}
  try { http.globalAgent.destroy(); } catch {}

  if (failures.length > 0) {
    const aggregate = new Error(
      `Clawket setup incomplete (${failures.length} component(s) failed):\n` +
      failures.map((f) => `  - ${f.message}`).join('\n') +
      '\nRun `clawket doctor` for diagnostics.'
    );
    throw aggregate;
  }
}

module.exports = {
  ensureInstalled,
  runPlanSync,
  runPostToolUse,
  runPreToolUse,
  runSessionStart,
  runSetup,
  runStop,
  runSubagentStart,
  runSubagentStop,
  runUserPromptSubmit,
  // Exposed for test harnesses only.
  __test__: {
    // Exposed so tests/pre-tool-use-schema.test.cjs can assert on the emitted
    // payload directly, without needing a live daemon to reach an allow path.
    allowPreToolUse,
    ensureCliBinary,
    ensureDaemonBinary,
    ensureWebBundle,
    ensureDesktopBundle,
    desktopArtifactName,
    isProjectDisabled,
    readInstalledVersion,
    strictGuideMessage,
    validateStrictPlan,
    writeInstalledVersion,
    // PDD anti-pattern helpers (X3/X7/X8/X9) — exported for unit tests.
    appendHookLog,
    checkX3ScenarioId,
    checkX7BatchSize,
    checkX8Evidence,
    checkX9SyncReasoning,
    getDaemonPort,
    detectCliTarget,
    fetchSha256Sums,
    parseSha256Sums,
    SKILLS_LIST,
    // Migration 027 — Stop-hook auto-advance helpers (pure, unit-testable).
    decideContinuation,
    continuationMarkerPath,
    // PreToolUse gate (project-scoped state + pure decision).
    decideGate,
    normalizeGateState,
    scopeTasksToProject,
    loadGateState,
    loadGateStateLegacy,
    classifyBashFastPath,
    detectDestructive,
    loadDestructivePatterns,
    // X8 evidence by reference.
    parseRunRefs,
    citesRuns,
    malformedRunRef,
    runRecordProblem,
    isUnreferencedTestClaim,
  },
};
