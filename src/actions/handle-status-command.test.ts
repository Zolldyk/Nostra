import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Memory } from '@elizaos/core';
import type { AgentState } from '../types/agent-state.js';
import { AgentStateService } from '../services/agent-state-service.js';
import { HandleStatusCommand } from './handle-status-command.js';

type CallbackPayload = {
  text: string;
  actions: string[];
  source: string;
};

describe('HandleStatusCommand', () => {
  let state: AgentState;
  let getStateMock: typeof AgentStateService.getState;

  beforeEach(() => {
    state = {
      mode: 'paper',
      trustLadder: 'advisor',
      crisisStatus: 'active',
      constitutionVersion: 1,
      accuracyScore: 75,
      suggestionsSampled: 12,
      onboardingState: 'pending',
      updatedAt: new Date().toISOString(),
    };

    getStateMock = AgentStateService.getState;
    AgentStateService.getState = (() => ({ ...state })) as typeof AgentStateService.getState;
  });

  afterEach(() => {
    AgentStateService.getState = getStateMock;
  });

  it('redirects while onboarding is still in progress', async () => {
    state = { ...state, onboardingState: 'socratic_in_progress' };
    const callback = mock(async (_payload: CallbackPayload) => undefined);

    await HandleStatusCommand.handler?.(
      {} as never,
      { content: { text: '/status' } } as Memory,
      undefined,
      undefined,
      callback,
    );

    const payload = callback.mock.calls[0]?.[0] as CallbackPayload;
    expect(payload.text).toBe("You haven't set up your constitution yet. Send `/start` to begin — it only takes a conversation.");
  });

  it('renders a status summary once onboarding is complete', async () => {
    state = { ...state, onboardingState: 'complete' };
    const callback = mock(async (_payload: CallbackPayload) => undefined);

    await HandleStatusCommand.handler?.(
      {} as never,
      { content: { text: '/status' } } as Memory,
      undefined,
      undefined,
      callback,
    );

    const payload = callback.mock.calls[0]?.[0] as CallbackPayload;
    expect(payload.text).toContain('Nostra — Agent Status');
    expect(payload.text).toContain('Mode: Paper Treasury');
    expect(payload.text).toContain('Trust Ladder: Advisor');
    expect(payload.text).toContain('Constitution: v1');
    expect(payload.text).toContain('Accuracy Score: 75%');
  });
});
