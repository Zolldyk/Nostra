import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { run } from '../db/migrations.js';
import type { DatabaseLike } from '../db/migrations.js';
import { AgentStateService } from './agent-state-service.js';

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

describe('AgentStateService', () => {
  let db: ReadableDb;

  beforeEach(() => {
    db = openInMemory();
  });

  it('initialises with exact default state', async () => {
    await AgentStateService.init(db);
    const state = AgentStateService.getState();
    expect(state.mode).toBe('paper');
    expect(state.trustLadder).toBe('advisor');
    expect(state.crisisStatus).toBe('active');
    expect(state.constitutionVersion).toBe(0);
    expect(state.accuracyScore).toBe(0);
    expect(state.suggestionsSampled).toBe(0);
    expect(state.onboardingState).toBe('pending');
    expect(typeof state.updatedAt).toBe('string');
  });

  it('persists default state to DB on first init', async () => {
    await AgentStateService.init(db);
    const row = db.prepare('SELECT * FROM agent_state WHERE id = 1').get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row['mode']).toBe('paper');
    expect(row['trust_ladder']).toBe('advisor');
  });

  it('setState merges update and writes through to DB immediately', async () => {
    await AgentStateService.init(db);
    await AgentStateService.setState({ mode: 'live', trustLadder: 'executor' }, db);

    const state = AgentStateService.getState();
    expect(state.mode).toBe('live');
    expect(state.trustLadder).toBe('executor');

    const row = db.prepare('SELECT * FROM agent_state WHERE id = 1').get() as Record<string, unknown>;
    expect(row['mode']).toBe('live');
    expect(row['trust_ladder']).toBe('executor');
  });

  it('getState returns a copy — external mutation does not affect internal state', async () => {
    await AgentStateService.init(db);
    const state1 = AgentStateService.getState();
    state1.mode = 'live';

    const state2 = AgentStateService.getState();
    expect(state2.mode).toBe('paper');
  });

  it('loads existing state from DB on re-init', async () => {
    await AgentStateService.init(db);
    await AgentStateService.setState({ accuracyScore: 75, suggestionsSampled: 10 }, db);
    await AgentStateService.init(db);

    const state = AgentStateService.getState();
    expect(state.accuracyScore).toBe(75);
    expect(state.suggestionsSampled).toBe(10);
  });

  it('initialises onboardingState to pending by default', async () => {
    await AgentStateService.init(db);
    expect(AgentStateService.getState().onboardingState).toBe('pending');
  });

  it('persists onboardingState to DB on init', async () => {
    await AgentStateService.init(db);
    const row = db.prepare('SELECT onboarding_state FROM agent_state WHERE id = 1').get() as Record<string, unknown>;
    expect(row['onboarding_state']).toBe('pending');
  });

  it('setState transitions onboardingState through the valid sequence', async () => {
    await AgentStateService.init(db);

    await AgentStateService.setState({ onboardingState: 'disclaimer_delivered' }, db);
    expect(AgentStateService.getState().onboardingState).toBe('disclaimer_delivered');

    await AgentStateService.setState({ onboardingState: 'socratic_in_progress' }, db);
    expect(AgentStateService.getState().onboardingState).toBe('socratic_in_progress');

    await AgentStateService.setState({ onboardingState: 'complete' }, db);
    expect(AgentStateService.getState().onboardingState).toBe('complete');
  });

  it('onboardingState persists through restart cycle', async () => {
    await AgentStateService.init(db);
    await AgentStateService.setState({ onboardingState: 'disclaimer_delivered' }, db);
    await AgentStateService.init(db);
    expect(AgentStateService.getState().onboardingState).toBe('disclaimer_delivered');
  });

  it('onboardingState DB column has correct value after setState', async () => {
    await AgentStateService.init(db);
    await AgentStateService.setState({ onboardingState: 'complete' }, db);

    const row = db.prepare('SELECT onboarding_state FROM agent_state WHERE id = 1').get() as Record<string, unknown>;
    expect(row['onboarding_state']).toBe('complete');
  });

  it('persists referralSource to DB and reads it back on re-init', async () => {
    await AgentStateService.init(db);
    await AgentStateService.setState({ referralSource: '12345678' }, db);

    const row = db.prepare('SELECT referral_source FROM agent_state WHERE id = 1').get() as Record<string, unknown>;
    expect(row['referral_source']).toBe('12345678');

    await AgentStateService.init(db);
    expect(AgentStateService.getState().referralSource).toBe('12345678');
  });
});
