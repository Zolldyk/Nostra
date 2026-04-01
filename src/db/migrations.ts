import { Database } from 'bun:sqlite';
import { ALL_SCHEMAS } from './schema.js';

// DatabaseLike — compatible with bun:sqlite Database and better-sqlite3 (same API)
export interface DatabaseLike {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
  };
}

const SQLITE_PATH = process.env.SQLITE_PATH ?? '/app/data/nostra.db';

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    _db = new Database(SQLITE_PATH);
    _db.run('PRAGMA journal_mode = WAL');
    _db.run('PRAGMA foreign_keys = ON');
  }
  return _db;
}

export function run(db: DatabaseLike): void {
  for (const sql of ALL_SCHEMAS) {
    db.prepare(sql).run();
  }
}
