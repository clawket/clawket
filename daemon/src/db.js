import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { paths, ensureDirs } from './paths.js';

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(DAEMON_ROOT, 'migrations');

let _db = null;
let _vecLoaded = false;

export function getDb() {
  if (_db) return _db;
  ensureDirs();
  _db = new Database(paths.db);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  // Load sqlite-vec extension
  if (!_vecLoaded) {
    try {
      const sqliteVec = await_import_sqlite_vec();
      if (sqliteVec) {
        sqliteVec.load(_db);
        _vecLoaded = true;
      }
    } catch {
      // sqlite-vec not available — vector search disabled
    }
  }

  ensureMigrated(_db);

  // Create vector tables if sqlite-vec is loaded
  if (_vecLoaded) {
    ensureVectorTables(_db);
  }

  return _db;
}

// Synchronous dynamic import workaround for sqlite-vec
function await_import_sqlite_vec() {
  try {
    return require('sqlite-vec');
  } catch {
    return null;
  }
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
    { version: 5, file: '005_activity_log.sql' },
    { version: 6, file: '006_labels.sql' },
    { version: 7, file: '007_reporter_review.sql' },
    { version: 8, file: '008_step_relations.sql' },
    { version: 9, file: '009_vector_search.sql' },
    { version: 10, file: '010_step_type.sql' },
  ];
  for (const m of migrations) {
    if (m.version > currentVersion) {
      const sql = readFileSync(join(MIGRATIONS_DIR, m.file), 'utf8');
      db.exec(sql);
    }
  }
}

function ensureVectorTables(db) {
  try {
    // Check if vec_steps already exists
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_steps'").get();
    if (!exists) {
      db.exec(`CREATE VIRTUAL TABLE vec_steps USING vec0(step_id TEXT PRIMARY KEY, embedding float[384])`);
      db.exec(`CREATE VIRTUAL TABLE vec_artifacts USING vec0(artifact_id TEXT PRIMARY KEY, embedding float[384])`);
    }
  } catch (err) {
    process.stderr.write(`[lattice-db] Vector table creation failed: ${err.message}\n`);
  }
}

export function isVecEnabled() {
  return _vecLoaded;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
