// XDG Base Directory Specification with env overrides.
// All runtime paths flow through this module. Source paths are fs-based and handled separately.
//
// Env overrides (highest precedence):
//   CLAWKET_DATA_DIR    — persistent data (db, attachments)
//   CLAWKET_CACHE_DIR   — regenerable state (socket, pid, tmp)
//   CLAWKET_CONFIG_DIR  — user config (toml/json)
//   CLAWKET_STATE_DIR   — logs, history (XDG state)
//
// Defaults (XDG):
//   data    ← $XDG_DATA_HOME   or ~/.local/share
//   cache   ← $XDG_CACHE_HOME  or ~/.cache
//   config  ← $XDG_CONFIG_HOME or ~/.config
//   state   ← $XDG_STATE_HOME  or ~/.local/state

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, existsSync, copyFileSync, renameSync } from 'node:fs';

const HOME = homedir();
const APP = 'clawket';

function xdg(envName, fallback) {
  return process.env[envName] || join(HOME, fallback);
}

function resolve(override, xdgVar, xdgFallback) {
  if (process.env[override]) return process.env[override];
  return join(xdg(xdgVar, xdgFallback), APP);
}

export const paths = {
  data:   resolve('CLAWKET_DATA_DIR',   'XDG_DATA_HOME',   '.local/share'),
  cache:  resolve('CLAWKET_CACHE_DIR',  'XDG_CACHE_HOME',  '.cache'),
  config: resolve('CLAWKET_CONFIG_DIR', 'XDG_CONFIG_HOME', '.config'),
  state:  resolve('CLAWKET_STATE_DIR',  'XDG_STATE_HOME',  '.local/state'),
};

// Derived file/subpaths
paths.db          = process.env.CLAWKET_DB || join(paths.data, 'db.sqlite');
paths.socket      = process.env.CLAWKET_SOCKET || join(paths.cache, 'clawketd.sock');
paths.pidFile     = join(paths.cache, 'clawketd.pid');
paths.portFile    = join(paths.cache, 'clawketd.port');
paths.logFile     = join(paths.state, 'clawketd.log');
paths.configFile  = join(paths.config, 'config.toml');

// Migrate data from legacy Lattice paths to Clawket paths
function migrateLegacyData() {
  const LEGACY_APP = 'lattice';
  const legacyData = join(xdg('XDG_DATA_HOME', '.local/share'), LEGACY_APP);
  const legacyDb = join(legacyData, 'db.sqlite');

  // Only migrate if legacy DB exists and new DB doesn't
  if (existsSync(legacyDb) && !existsSync(paths.db)) {
    try {
      mkdirSync(paths.data, { recursive: true });
      copyFileSync(legacyDb, paths.db);
      // Rename legacy DB to mark as migrated (prevent duplicate migration)
      renameSync(legacyDb, legacyDb + '.migrated-to-clawket');
      process.stderr.write(`[clawket] Migrated database from ${legacyDb} → ${paths.db}\n`);
    } catch (err) {
      process.stderr.write(`[clawket] WARNING: Failed to migrate legacy database: ${err.message}\n`);
    }
  }
}

export function ensureDirs() {
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(paths.cache, { recursive: true });
  mkdirSync(paths.config, { recursive: true });
  mkdirSync(paths.state, { recursive: true });
  migrateLegacyData();
}
