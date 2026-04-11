// XDG Base Directory Specification with env overrides.
// All runtime paths flow through this module. Source paths are fs-based and handled separately.
//
// Env overrides (highest precedence):
//   LATTICE_DATA_DIR    — persistent data (db, attachments)
//   LATTICE_CACHE_DIR   — regenerable state (socket, pid, tmp)
//   LATTICE_CONFIG_DIR  — user config (toml/json)
//   LATTICE_STATE_DIR   — logs, history (XDG state)
//
// Defaults (XDG):
//   data    ← $XDG_DATA_HOME   or ~/.local/share
//   cache   ← $XDG_CACHE_HOME  or ~/.cache
//   config  ← $XDG_CONFIG_HOME or ~/.config
//   state   ← $XDG_STATE_HOME  or ~/.local/state

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

const HOME = homedir();
const APP = 'lattice';

function xdg(envName, fallback) {
  return process.env[envName] || join(HOME, fallback);
}

function resolve(override, xdgVar, xdgFallback) {
  if (process.env[override]) return process.env[override];
  return join(xdg(xdgVar, xdgFallback), APP);
}

export const paths = {
  data:   resolve('LATTICE_DATA_DIR',   'XDG_DATA_HOME',   '.local/share'),
  cache:  resolve('LATTICE_CACHE_DIR',  'XDG_CACHE_HOME',  '.cache'),
  config: resolve('LATTICE_CONFIG_DIR', 'XDG_CONFIG_HOME', '.config'),
  state:  resolve('LATTICE_STATE_DIR',  'XDG_STATE_HOME',  '.local/state'),
};

// Derived file/subpaths
paths.db          = process.env.LATTICE_DB || join(paths.data, 'db.sqlite');
paths.socket      = process.env.LATTICE_SOCKET || join(paths.cache, 'latticed.sock');
paths.pidFile     = join(paths.cache, 'latticed.pid');
paths.portFile    = join(paths.cache, 'latticed.port');
paths.logFile     = join(paths.state, 'latticed.log');
paths.configFile  = join(paths.config, 'config.toml');

export function ensureDirs() {
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(paths.cache, { recursive: true });
  mkdirSync(paths.config, { recursive: true });
  mkdirSync(paths.state, { recursive: true });
}
