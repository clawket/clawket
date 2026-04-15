#!/usr/bin/env node
import { spawn, execSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { paths, ensureDirs } from '../src/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVE_SCRIPT = join(__dirname, '_serve.js');

function readPid() {
  try {
    return Number(readFileSync(paths.pidFile, 'utf-8').trim());
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function httpHealthCheck() {
  return new Promise((resolve) => {
    import('node:http').then(({ request }) => {
      const req = request({ socketPath: paths.socket, path: '/health', method: 'GET' }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    });
  });
}

async function waitForReady(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await httpHealthCheck();
    if (health?.ok) return health;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

// ========== Commands ==========

function ensureDeps() {
  const daemonRoot = join(__dirname, '..');
  const nodeModules = join(daemonRoot, 'node_modules');
  if (existsSync(join(daemonRoot, 'package.json')) && !existsSync(nodeModules)) {
    process.stderr.write(`[clawketd] Installing daemon dependencies...\n`);
    const npmrc = join(daemonRoot, '.npmrc');
    if (!existsSync(npmrc)) writeFileSync(npmrc, 'node-linker=hoisted\n');
    try {
      execSync('pnpm --version', { stdio: 'pipe' });
      execSync('pnpm install --prod', { cwd: daemonRoot, stdio: ['pipe', 'pipe', process.stderr], timeout: 120000 });
      process.stderr.write(`[clawketd] Dependencies installed (pnpm)\n`);
    } catch {
      try {
        execSync('npm install --production', { cwd: daemonRoot, stdio: ['pipe', 'pipe', process.stderr], timeout: 120000 });
        process.stderr.write(`[clawketd] Dependencies installed (npm)\n`);
      } catch (e) {
        process.stderr.write(`[clawketd] ERROR: Failed to install dependencies: ${e.message}\n`);
      }
    }
  }
}

async function cmdStart() {
  ensureDirs();
  ensureDeps();
  const pid = readPid();
  if (pid && isRunning(pid)) {
    const health = await httpHealthCheck();
    if (health?.ok) {
      process.stdout.write(`clawketd: already running (pid=${pid})\n`);
      process.exit(0);
    }
  }

  const logFd = await import('node:fs').then(fs =>
    fs.openSync(paths.logFile, 'a')
  );

  const child = spawn(process.execPath, [SERVE_SCRIPT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });
  child.unref();

  const health = await waitForReady();
  if (health) {
    process.stdout.write(`clawketd: started (pid=${child.pid})\n`);
  } else {
    process.stderr.write(`clawketd: failed to start (check ${paths.logFile})\n`);
    process.exit(1);
  }
}

async function cmdStop() {
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    process.stdout.write('clawketd: not running\n');
    return;
  }
  process.kill(pid, 'SIGTERM');
  // 종료 대기 (최대 5초)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isRunning(pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isRunning(pid)) {
    process.stderr.write(`clawketd: pid=${pid} did not stop, sending SIGKILL\n`);
    process.kill(pid, 'SIGKILL');
  } else {
    process.stdout.write(`clawketd: stopped (pid=${pid})\n`);
  }
}

async function cmdStatus() {
  const pid = readPid();
  if (!pid) {
    process.stdout.write('clawketd: not running (no pid file)\n');
    process.exit(1);
  }
  if (!isRunning(pid)) {
    process.stdout.write(`clawketd: not running (stale pid=${pid})\n`);
    process.exit(1);
  }
  const health = await httpHealthCheck();
  if (health?.ok) {
    process.stdout.write(`clawketd: running (pid=${pid}, uptime=${Math.round(health.uptime_ms / 1000)}s, version=${health.version})\n`);
  } else {
    process.stdout.write(`clawketd: process alive (pid=${pid}) but not responding\n`);
    process.exit(1);
  }
}

async function cmdRestart() {
  await cmdStop();
  await cmdStart();
}

// ========== Main ==========

const cmd = process.argv[2];
switch (cmd) {
  case 'start':   await cmdStart(); break;
  case 'stop':    await cmdStop(); break;
  case 'status':  await cmdStatus(); break;
  case 'restart': await cmdRestart(); break;
  case 'serve':
    // foreground 모드 (디버깅용)
    const { startServer } = await import('../src/server.js');
    startServer();
    break;
  default:
    process.stdout.write(`Usage: clawketd <start|stop|status|restart|serve>

  start    Start daemon in background
  stop     Stop running daemon
  status   Show daemon status
  restart  Restart daemon
  serve    Run in foreground (for debugging)
`);
    if (cmd) process.exit(1);
}
