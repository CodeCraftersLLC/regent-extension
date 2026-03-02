import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sqliteVec from 'sqlite-vec';
import { config } from '../config.js';
import { log } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');

  // Load sqlite-vec extension for vector search
  sqliteVec.load(_db);

  runMigrations(_db);
  log.info('Database initialized at %s (sqlite-vec loaded)', config.dbPath);
  return _db;
}

function runMigrations(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((r: any) => r.name)
  );

  const migrationsDir = resolve(__dirname, 'migrations');
  const files = ['001_foundation.sql', '002_memory_fts.sql', '003_agents_mcp.sql', '004_multiuser.sql'];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(resolve(migrationsDir, file), 'utf-8');
    // Atomic: apply migration SQL + record in single transaction
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    })();
    log.info('Applied migration: %s', file);
  }
}

export function closeDb() {
  _db?.close();
  _db = null;
}
