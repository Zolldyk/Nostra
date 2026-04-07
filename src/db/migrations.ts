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
  // Story 2.1: add onboarding_state to databases created by Story 1.1
  try {
    db.prepare("ALTER TABLE agent_state ADD COLUMN onboarding_state TEXT NOT NULL DEFAULT 'pending'").run();
  } catch {
    // Column already exists — idempotent
  }
  // Story 2.4: add referral_source for Storyteller narrative context
  try {
    db.prepare("ALTER TABLE agent_state ADD COLUMN referral_source TEXT").run();
  } catch {
    // Column already exists — idempotent
  }
}
