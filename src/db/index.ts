// SQLite database connection and schema initialization
// Architecture: one global DB at ~/.maven-codegraph/artifacts.db (shared across projects)

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db: Database.Database | null = null;

/** Get or create the global artifact database */
export function getDb(): Database.Database {
  if (_db) return _db;

  const dir = path.join(homeDir(), '.maven-codegraph');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const dbPath = path.join(dir, 'artifacts.db');
  _db = new Database(dbPath);

  // Performance pragmas
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  _db.pragma('foreign_keys = ON');
  _db.pragma('cache_size = -65536');
  _db.pragma('mmap_size = 268435456');

  initSchema(_db);
  return _db;
}

/** Initialize database schema from schema.sql */
function initSchema(db: Database.Database): void {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');

  db.exec(schema);

  // Insert schema version if not present
  const currentVersion = 1;
  const existing = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
  if (!existing || existing.version < currentVersion) {
    db.prepare('INSERT OR REPLACE INTO schema_version (version, description) VALUES (?, ?)').run(
      currentVersion, 'Initial schema: artifacts, nodes, edges, methods, FTS5'
    );
  }
}

/** Close the database connection */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '/tmp';
}
