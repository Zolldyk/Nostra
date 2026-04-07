import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Memory } from '@elizaos/core';
import type { AgentState } from '../types/agent-state.js';

type CallbackPayload = {
  text: string;
  actions: string[];
  source: string;
};

describe('HandleConstitutionCommand', () => {
  let state: AgentState;
  let activeConstitution: Record<string, unknown> | undefined;
  let rules: Array<Record<string, unknown>>;

  beforeEach(async () => {
    const actualMigrations = await import('../db/migrations.js');

    state = {
      mode: 'paper',
      trustLadder: 'advisor',
      crisisStatus: 'active',
      constitutionVersion: 0,
      accuracyScore: 0,
      suggestionsSampled: 0,
      onboardingState: 'pending',
      updatedAt: new Date().toISOString(),
    };
    activeConstitution = undefined;
    rules = [];

    mock.module('../services/agent-state-service.js', () => ({
      AgentStateService: {
        getState: () => ({ ...state }),
      },
    }));

    mock.module('../db/migrations.js', () => ({
      ...actualMigrations,
      getDb: () => ({
        prepare(sql: string) {
          if (sql.includes('FROM constitution_rules')) {
            return {
              get: () => undefined,
              all: (constitutionId?: number) =>
                constitutionId === activeConstitution?.id ? rules : [],
            };
          }

          if (sql.includes('FROM constitution')) {
            return {
              get: () => activeConstitution,
              all: () => [],
            };
          }

          throw new Error(`Unexpected SQL in test: ${sql}`);
        },
      }),
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  it('validates /constitution', async () => {
    const { HandleConstitutionCommand } = await import('./handle-constitution-command.js');
    const message = { content: { text: '/constitution' } } as Memory;
    await expect(HandleConstitutionCommand.validate!({} as never, message)).resolves.toBe(true);
  });

  it('redirects to /start when onboarding is incomplete', async () => {
    state = { ...state, onboardingState: 'socratic_in_progress' };
    const { HandleConstitutionCommand } = await import('./handle-constitution-command.js');
    const callback = mock(async (_payload: CallbackPayload) => undefined);

    await HandleConstitutionCommand.handler?.(
      {} as never,
      { content: { text: '/constitution' } } as Memory,
      undefined,
      undefined,
      callback,
    );

    const payload = callback.mock.calls[0]?.[0] as CallbackPayload;
    expect(payload.text).toBe("You haven't set up your constitution yet. Send `/start` to begin — it only takes a conversation.");
  });

  it('redirects when no active constitution exists', async () => {
    state = { ...state, onboardingState: 'complete', constitutionVersion: 1 };
    const { HandleConstitutionCommand } = await import('./handle-constitution-command.js');
    const callback = mock(async (_payload: CallbackPayload) => undefined);

    await HandleConstitutionCommand.handler?.(
      {} as never,
      { content: { text: '/constitution' } } as Memory,
      undefined,
      undefined,
      callback,
    );

    const payload = callback.mock.calls[0]?.[0] as CallbackPayload;
    expect(payload.text).toBe('No active constitution found. Send `/start` to create one.');
  });

  it('renders the constitution display block when onboarded', async () => {
    state = { ...state, onboardingState: 'complete', constitutionVersion: 1 };
    activeConstitution = {
      id: 7,
      version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    rules = [
      { rule_index: 0, rule_json: '{"description":"No leverage above 2x"}' },
      { rule_index: 1, rule_json: '{"description":"Only stablecoins in bear markets"}' },
    ];
    const { HandleConstitutionCommand } = await import('./handle-constitution-command.js');
    const callback = mock(async (_payload: CallbackPayload) => undefined);

    await HandleConstitutionCommand.handler?.(
      {} as never,
      { content: { text: '/constitution' } } as Memory,
      undefined,
      undefined,
      callback,
    );

    const payload = callback.mock.calls[0]?.[0] as CallbackPayload;
    expect(payload.text).toContain('Your Constitution — Version 1');
    expect(payload.text).toContain('`Rule #1: No leverage above 2x`');
    expect(payload.text).toContain('`Rule #2: Only stablecoins in bear markets`');
    expect(payload.text).toContain('Constitutional compliance: 100%.');
  });
});
