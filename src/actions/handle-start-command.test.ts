import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Memory } from '@elizaos/core';
import type { AgentState } from '../types/agent-state.js';

type CallbackPayload = {
  text: string;
  actions: string[];
  source: string;
};

describe('HandleStartCommand', () => {
  let state: AgentState;
  let setStateCalls: Array<Partial<AgentState>>;

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
    setStateCalls = [];

    mock.module('../services/agent-state-service.js', () => ({
      AgentStateService: {
        getState: () => ({ ...state }),
        setState: async (update: Partial<AgentState>) => {
          setStateCalls.push(update);
          state = { ...state, ...update, updatedAt: new Date().toISOString() };
        },
      },
    }));

    mock.module('../db/migrations.js', () => ({
      ...actualMigrations,
      getDb: () => ({}),
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  it('validates /start case-insensitively', async () => {
    const { HandleStartCommand } = await import('./handle-start-command.js');
    const message = { content: { text: ' /START hello ' } } as Memory;
    await expect(HandleStartCommand.validate!({} as never, message)).resolves.toBe(true);
  });

  it('rejects non-/start commands', async () => {
    const { HandleStartCommand } = await import('./handle-start-command.js');
    const message = { content: { text: '/status' } } as Memory;
    await expect(HandleStartCommand.validate!({} as never, message)).resolves.toBe(false);
  });

  it('sends the disclaimer and records disclaimer_delivered for a new user', async () => {
    const { HandleStartCommand } = await import('./handle-start-command.js');
    const callback = mock(async (_payload: CallbackPayload) => undefined);

    await HandleStartCommand.handler?.(
      {} as never,
      { content: { text: '/start' } } as Memory,
      undefined,
      undefined,
      callback,
    );

    expect(callback).toHaveBeenCalledTimes(1);
    const payload = callback.mock.calls[0]?.[0] as CallbackPayload;
    expect(payload.text).toContain("Welcome. I'm Nostra");
    expect(payload.text).toContain('I am not a financial advisor.');
    expect(payload.text).toContain('Your money. Your rules. Your responsibility.');
    expect(setStateCalls).toEqual([{ onboardingState: 'disclaimer_delivered' }]);
  });

  it('greets returning users without restarting onboarding', async () => {
    state = {
      ...state,
      constitutionVersion: 2,
      accuracyScore: 85,
      onboardingState: 'complete',
    };
    const { HandleStartCommand } = await import('./handle-start-command.js');
    const callback = mock(async (_payload: CallbackPayload) => undefined);

    await HandleStartCommand.handler?.(
      {} as never,
      { content: { text: '/start' } } as Memory,
      undefined,
      undefined,
      callback,
    );

    expect(callback).toHaveBeenCalledTimes(1);
    const payload = callback.mock.calls[0]?.[0] as CallbackPayload;
    expect(payload.text).toContain('Welcome back.');
    expect(payload.text).toContain('Your Constitution v2 is active.');
    expect(payload.text).not.toContain('I am not a financial advisor.');
    expect(setStateCalls).toHaveLength(0);
  });

  it('re-sends the disclaimer when onboarding is in progress and no constitution exists', async () => {
    state = {
      ...state,
      onboardingState: 'disclaimer_delivered',
    };
    const { HandleStartCommand } = await import('./handle-start-command.js');
    const callback = mock(async (_payload: CallbackPayload) => undefined);

    await HandleStartCommand.handler?.(
      {} as never,
      { content: { text: '/start' } } as Memory,
      undefined,
      undefined,
      callback,
    );

    const payload = callback.mock.calls[0]?.[0] as CallbackPayload;
    expect(payload.text).toContain("Welcome. I'm Nostra");
    expect(setStateCalls).toEqual([{ onboardingState: 'disclaimer_delivered' }]);
  });

  it('persists referralSource before sending the disclaimer for a referred new user', async () => {
    const { HandleStartCommand } = await import('./handle-start-command.js');
    const callback = mock(async (_payload: CallbackPayload) => undefined);

    await HandleStartCommand.handler?.(
      {} as never,
      { content: { text: '/start ref_12345678' } } as Memory,
      undefined,
      undefined,
      callback,
    );

    expect(setStateCalls).toEqual([
      { referralSource: '12345678' },
      { onboardingState: 'disclaimer_delivered' },
    ]);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('ignores referral parameters for existing users', async () => {
    state = {
      ...state,
      constitutionVersion: 1,
      onboardingState: 'complete',
    };
    const { HandleStartCommand } = await import('./handle-start-command.js');
    const callback = mock(async (_payload: CallbackPayload) => undefined);

    await HandleStartCommand.handler?.(
      {} as never,
      { content: { text: '/start ref_12345678' } } as Memory,
      undefined,
      undefined,
      callback,
    );

    expect(setStateCalls).toEqual([]);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
