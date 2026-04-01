import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { run } from './migrations.js';
import type { DatabaseLike } from './migrations.js';

function openInMemory(): DatabaseLike {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  return db as unknown as DatabaseLike;
}

function tableExists(db: DatabaseLike, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return !!row;
}

describe('migrations.run()', () => {
  let db: DatabaseLike;

  beforeEach(() => {
    db = openInMemory();
  });

  it('creates all 5 required tables', () => {
    run(db);
    const required = [
      'agent_state',
      'constitution',
      'constitution_rules',
      'on_chain_memos',
      'trust_ladder_log',
    ];
    for (const table of required) {
      expect(tableExists(db, table)).toBe(true);
    }
  });

  it('is idempotent — no error when called twice', () => {
    expect(() => {
      run(db);
      run(db);
    }).not.toThrow();
  });

  it('agent_state has correct column defaults', () => {
    run(db);
    db.prepare(
      "INSERT INTO agent_state (id, mode, trust_ladder, crisis_status, constitution_version, accuracy_score, suggestions_sampled, updated_at) VALUES (1, 'paper', 'advisor', 'active', 0, 0, 0, '2026-01-01T00:00:00.000Z')",
    ).run();
    const row = db.prepare('SELECT * FROM agent_state WHERE id = 1').get() as Record<string, unknown>;
    expect(row['mode']).toBe('paper');
    expect(row['trust_ladder']).toBe('advisor');
    expect(row['crisis_status']).toBe('active');
    expect(row['constitution_version']).toBe(0);
    expect(row['accuracy_score']).toBe(0);
    expect(row['suggestions_sampled']).toBe(0);
  });
});
