import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Memory } from '@elizaos/core';
import type { AgentState } from '../types/agent-state.js';

type CallbackPayload = {
  text: string;
  actions: string[];
  source: string;
};

describe('GenerateReferralLinkAction', () => {
  let state: AgentState;

  beforeEach(() => {
    state = {
      mode: 'paper',
      trustLadder: 'advisor',
      crisisStatus: 'active',
      constitutionVersion: 1,
      accuracyScore: 0,
      suggestionsSampled: 0,
      onboardingState: 'complete',
      updatedAt: new Date().toISOString(),
    };

    mock.module('../services/agent-state-service.js', () => ({
      AgentStateService: {
        getState: () => ({ ...state }),
      },
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  it('validate returns false if no active constitution', async () => {
    state = { ...state, constitutionVersion: 0 };
    const { GenerateReferralLinkAction } = await import('./generate-referral-link.js');
    const message = { content: { text: 'Can I get a referral link?' } } as Memory;
    await expect(GenerateReferralLinkAction.validate!({} as never, message)).resolves.toBe(false);
  });

  it('validate returns false for /command messages', async () => {
    const { GenerateReferralLinkAction } = await import('./generate-referral-link.js');
    const message = { content: { text: '/referral' } } as Memory;
    await expect(GenerateReferralLinkAction.validate!({} as never, message)).resolves.toBe(false);
  });

  it('validate returns true for "referral link" intent with active constitution', async () => {
    const { GenerateReferralLinkAction } = await import('./generate-referral-link.js');
    const message = { content: { text: 'Can I get a referral link?' } } as Memory;
    await expect(GenerateReferralLinkAction.validate!({} as never, message)).resolves.toBe(true);
  });

  it('validate returns true for "invite" keyword', async () => {
    const { GenerateReferralLinkAction } = await import('./generate-referral-link.js');
    const message = { content: { text: 'I want to invite a friend' } } as Memory;
    await expect(GenerateReferralLinkAction.validate!({} as never, message)).resolves.toBe(true);
  });

  it('handler produces correct t.me deep link', async () => {
    process.env.TELEGRAM_BOT_USERNAME = 'TestBot';
    const { GenerateReferralLinkAction } = await import('./generate-referral-link.js');
    const callback = mock(async (_payload: CallbackPayload) => undefined);

    await GenerateReferralLinkAction.handler?.(
      {} as never,
      { userId: '111222333', content: { text: 'Can I get a referral link?' } } as Memory,
      undefined,
      undefined,
      callback,
    );

    expect(callback).toHaveBeenCalledTimes(1);
    const payload = callback.mock.calls[0]?.[0] as CallbackPayload;
    expect(payload.text).toContain('t.me/TestBot?start=ref_111222333');
    expect(payload.text).toContain('Paper Treasury — simulate first, commit when ready.');
  });

  it('handler uses fallback bot username if env var missing', async () => {
    delete process.env.TELEGRAM_BOT_USERNAME;
    const { GenerateReferralLinkAction } = await import('./generate-referral-link.js');
    const callback = mock(async (_payload: CallbackPayload) => undefined);

    await GenerateReferralLinkAction.handler?.(
      {} as never,
      { userId: '999', content: { text: 'referral link please' } } as Memory,
      undefined,
      undefined,
      callback,
    );

    const payload = callback.mock.calls[0]?.[0] as CallbackPayload;
    expect(payload.text).toContain('NostraBot');
  });
});
