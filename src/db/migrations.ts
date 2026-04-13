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
  // Story 3.1: paper_positions seeds on first run — no ALTER needed (new table via ALL_SCHEMAS)
  // No seed INSERT needed — PortfolioProvider handles empty table gracefully
  // Story 3.2: telegram_chat_id for polling loop proactive messaging
  try {
    db.prepare("ALTER TABLE agent_state ADD COLUMN telegram_chat_id TEXT").run();
  } catch {
    // Column already exists — idempotent
  }
  // Story 3.3: status column for failed memo tracking
  try {
    db.prepare("ALTER TABLE on_chain_memos ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'").run();
  } catch {
    // Column already exists — idempotent
  }
  // Story 3.4: status column for pending suggestion tracking
  try {
    db.prepare("ALTER TABLE trust_ladder_log ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'").run();
  } catch {
    // Column already exists — idempotent
  }
  // Story 3.4: unique constraint on suggestion_id for INSERT OR IGNORE deduplication
  try {
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_ladder_suggestion_id ON trust_ladder_log(suggestion_id)").run();
  } catch {
    // Index already exists — idempotent
  }
  // Story 3.6: promotion_pending for Trust Ladder 80% threshold flag
  try {
    db.prepare("ALTER TABLE agent_state ADD COLUMN promotion_pending INTEGER NOT NULL DEFAULT 0").run();
  } catch {
    // Column already exists — idempotent
  }
  // Story 5.2: crisis_episodes table for Crisis Protocol audit trail + Storyteller context
  // New table added to ALL_SCHEMAS — no ALTER needed
  // Story 6.1: storyteller_chapters for chapter number tracking
  // New table added to ALL_SCHEMAS — no ALTER needed
}
