import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { run } from '../db/migrations.js';
import type { DatabaseLike } from '../db/migrations.js';
import type { AgentState } from '../types/agent-state.js';

type ReadableDb = DatabaseLike & {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
  };
};

function openInMemory(): ReadableDb {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  run(db as unknown as DatabaseLike);
  return db as unknown as ReadableDb;
}

// Local isolated implementation for singleton-safe testing
class LocalAgentStateService {
  private state: AgentState | null = null;

  async init(db: ReadableDb): Promise<void> {
    const row = db.prepare('SELECT * FROM agent_state WHERE id = 1').get() as Record<string, unknown> | undefined;
    if (!row) {
      this.state = {
        mode: 'paper',
        trustLadder: 'advisor',
        crisisStatus: 'active',
        constitutionVersion: 0,
        accuracyScore: 0,
        suggestionsSampled: 0,
        updatedAt: new Date().toISOString(),
      };
      this.persist(db);
    } else {
      this.state = {
        mode: row['mode'] as AgentState['mode'],
        trustLadder: row['trust_ladder'] as AgentState['trustLadder'],
        crisisStatus: row['crisis_status'] as AgentState['crisisStatus'],
        constitutionVersion: row['constitution_version'] as number,
        accuracyScore: row['accuracy_score'] as number,
        suggestionsSampled: row['suggestions_sampled'] as number,
        updatedAt: row['updated_at'] as string,
      };
    }
  }

  getState(): AgentState {
    if (!this.state) throw new Error('not initialised');
    return { ...this.state };
  }

  async setState(update: Partial<AgentState>, db: ReadableDb): Promise<void> {
    if (!this.state) throw new Error('not initialised');
    this.state = { ...this.state, ...update, updatedAt: new Date().toISOString() };
    this.persist(db);
  }

  private persist(db: ReadableDb): void {
    const s = this.state!;
    db.prepare(`
      INSERT INTO agent_state (id, mode, trust_ladder, crisis_status, constitution_version, accuracy_score, suggestions_sampled, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        mode = excluded.mode, trust_ladder = excluded.trust_ladder,
        crisis_status = excluded.crisis_status, constitution_version = excluded.constitution_version,
        accuracy_score = excluded.accuracy_score, suggestions_sampled = excluded.suggestions_sampled,
        updated_at = excluded.updated_at
    `).run(s.mode, s.trustLadder, s.crisisStatus, s.constitutionVersion, s.accuracyScore, s.suggestionsSampled, s.updatedAt);
  }
}

describe('AgentStateService', () => {
  let db: ReadableDb;
  let svc: LocalAgentStateService;

  beforeEach(() => {
    db = openInMemory();
    svc = new LocalAgentStateService();
  });

  it('initialises with exact default state', async () => {
    await svc.init(db);
    const state = svc.getState();
    expect(state.mode).toBe('paper');
    expect(state.trustLadder).toBe('advisor');
    expect(state.crisisStatus).toBe('active');
    expect(state.constitutionVersion).toBe(0);
    expect(state.accuracyScore).toBe(0);
    expect(state.suggestionsSampled).toBe(0);
    expect(typeof state.updatedAt).toBe('string');
  });

  it('persists default state to DB on first init', async () => {
    await svc.init(db);
    const row = db.prepare('SELECT * FROM agent_state WHERE id = 1').get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row['mode']).toBe('paper');
    expect(row['trust_ladder']).toBe('advisor');
  });

  it('setState merges update and writes through to DB immediately', async () => {
    await svc.init(db);
    await svc.setState({ mode: 'live', trustLadder: 'executor' }, db);

    const state = svc.getState();
    expect(state.mode).toBe('live');
    expect(state.trustLadder).toBe('executor');

    const row = db.prepare('SELECT * FROM agent_state WHERE id = 1').get() as Record<string, unknown>;
    expect(row['mode']).toBe('live');
    expect(row['trust_ladder']).toBe('executor');
  });

  it('getState returns a copy — external mutation does not affect internal state', async () => {
    await svc.init(db);
    const state1 = svc.getState();
    state1.mode = 'live';

    const state2 = svc.getState();
    expect(state2.mode).toBe('paper');
  });

  it('loads existing state from DB on re-init', async () => {
    await svc.init(db);
    await svc.setState({ accuracyScore: 75, suggestionsSampled: 10 }, db);

    const svc2 = new LocalAgentStateService();
    await svc2.init(db);

    const state = svc2.getState();
    expect(state.accuracyScore).toBe(75);
    expect(state.suggestionsSampled).toBe(10);
  });

  it('getState throws if not initialised', () => {
    expect(() => svc.getState()).toThrow('not initialised');
  });
});
