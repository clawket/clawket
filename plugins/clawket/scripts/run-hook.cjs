#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const hookName = process.argv[2] || '';

const HOOK_ENTRYPOINTS = {
  'session-start': 'runSessionStart',
  'user-prompt-submit': 'runUserPromptSubmit',
  'pre-tool-use': 'runPreToolUse',
  'post-tool-use': 'runPostToolUse',
  stop: 'runStop',
};

function readRawStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseHookInput(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function readPinnedClawketRoot(pluginRoot) {
  try {
    const value = fs.readFileSync(path.join(pluginRoot, '.clawket-root'), 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

function isClawketRoot(candidate) {
  if (!candidate) return false;
  const current = path.resolve(candidate);
  return (
    fs.existsSync(path.join(current, 'adapters', 'shared', 'codex-hooks.cjs'))
    && fs.existsSync(path.join(current, 'bin', 'clawket'))
    && fs.existsSync(path.join(current, 'daemon'))
  );
}

function findWorkspaceRoot(startDir) {
  let current = path.resolve(startDir || process.cwd());
  while (true) {
    if (isClawketRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function main() {
  const rawInput = readRawStdin();
  const hookInput = parseHookInput(rawInput);
  const cwd = hookInput.cwd || process.env.HOOK_CWD || process.env.PWD || process.cwd();
  const pluginRoot = path.resolve(__dirname, '..');
  const workspaceRoot = (
    process.env.CLAWKET_ROOT
    || readPinnedClawketRoot(pluginRoot)
    || (isClawketRoot(pluginRoot) ? pluginRoot : null)
    || findWorkspaceRoot(cwd)
  );

  if (!workspaceRoot) {
    process.stdout.write('{}');
    process.exit(0);
  }

  const entrypoint = HOOK_ENTRYPOINTS[hookName];
  if (!entrypoint) {
    process.stdout.write('{}');
    process.exit(0);
  }

  const runner = `
const mod = require(${JSON.stringify(path.join(workspaceRoot, 'adapters', 'shared', 'codex-hooks.cjs'))});
mod[${JSON.stringify(entrypoint)}]();
`;

  const child = spawnSync(process.execPath, ['-e', runner], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      CLAWKET_ROOT: workspaceRoot,
      CODEX_PLUGIN_ROOT: workspaceRoot,
      HOOK_CWD: cwd,
    },
    input: rawInput,
    encoding: 'utf8',
  });

  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  process.exit(child.status ?? 0);
}

main();
