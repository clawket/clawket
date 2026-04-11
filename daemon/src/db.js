import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, ensureDirs } from './paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(DAEMON_ROOT, 'migrations');

let _db = null;

export function getDb() {
  if (_db) return _db;
  ensureDirs();
  _db = new Database(paths.db);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  ensureMigrated(_db);
  return _db;
}

function ensureMigrated(db) {
  const hasSchemaTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  const currentVersion = hasSchemaTable
    ? (db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0)
    : 0;
  const migrations = [
    { version: 1, file: '001_initial.sql' },
    { version: 2, file: '002_questions_and_approval.sql' },
    { version: 3, file: '003_v3.sql' },
    { version: 4, file: '004_bolts.sql' },
  ];
  for (const m of migrations) {
    if (m.version > currentVersion) {
      const sql = readFileSync(join(MIGRATIONS_DIR, m.file), 'utf8');
      db.exec(sql);
    }
  }
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
