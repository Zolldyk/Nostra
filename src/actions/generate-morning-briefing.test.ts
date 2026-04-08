import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import * as portfolioProvider from '../providers/portfolio-provider.js';
import * as yieldRatesProvider from '../providers/yield-rates-provider.js';
import { generateMorningBriefing } from './generate-morning-briefing.js';

function makeState(overrides: Partial<ReturnType<typeof AgentStateService.getState>>) {
  return {
    mode: 'paper' as const,
    trustLadder: 'advisor' as const,
    crisisStatus: 'active' as const,
    constitutionVersion: 0,
    accuracyScore: 0,
    suggestionsSampled: 0,
    onboardingState: 'complete' as const,
    updatedAt: new Date().toISOString(),
    telegramChatId: 'chat-123',
    ...overrides,
  };
}

function makeMockRuntime(useModelResult?: string | Error): IAgentRuntime & { _sentMessages: string[] } {
  const sentMessages: string[] = [];
  const telegramClient = {
    type: 'telegram',
    bot: {
      telegram: {
        sendMessage: mock(async (_chatId: string, text: string) => {
          sentMessages.push(text);
        }),
      },
    },
  };
  const rt = {
    clients: [telegramClient],
    useModel: mock(async () => {
      if (useModelResult instanceof Error) throw useModelResult;
      return useModelResult ?? 'LLM briefing body.\n\n🫡 Nostra';
    }),
    _sentMessages: sentMessages,
  } as unknown as IAgentRuntime & { _sentMessages: string[] };
  return rt;
}

function makeWordyBriefing(wordCount: number): string {
  return `${Array.from({ length: wordCount }, (_, index) => `word${index + 1}`).join(' ')}\n\n🫡 Nostra`;
}

describe('generateMorningBriefing', () => {
  let getStateSpy: ReturnType<typeof spyOn>;
  let getSnapshotSpy: ReturnType<typeof spyOn>;
  let yieldGetSpy: ReturnType<typeof spyOn>;

  const MOCK_YIELD_RESULT = {
    values: { kamino_apy: 6.5, marginfi_apy: 7.25, drift_apy: 5.0 },
  };

  beforeEach(() => {
    getSnapshotSpy = spyOn(portfolioProvider, 'getPaperPortfolioSnapshot').mockReturnValue([]);
    yieldGetSpy = spyOn(yieldRatesProvider.YieldRatesProvider, 'get').mockResolvedValue(MOCK_YIELD_RESULT as any);
  });

  afterEach(() => {
    getStateSpy?.mockRestore();
    getSnapshotSpy.mockRestore();
    yieldGetSpy.mockRestore();
  });

  it('exits silently when mode is not "paper"', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(
      makeState({ mode: 'live' as any, telegramChatId: 'chat-123' })
    );
    const rt = makeMockRuntime();
    await generateMorningBriefing(rt);
    expect(rt._sentMessages).toHaveLength(0);
  });

  it('exits silently when telegramChatId is falsy', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(
      makeState({ telegramChatId: undefined })
    );
    const rt = makeMockRuntime();
    await generateMorningBriefing(rt);
    expect(rt._sentMessages).toHaveLength(0);
  });

  it('sends ⏳ Thinking... as the first message before LLM call', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime();
    await generateMorningBriefing(rt);
    expect(rt._sentMessages.length).toBeGreaterThanOrEqual(1);
    expect(rt._sentMessages[0]).toContain('⏳ Thinking...');
  });

  it('first message includes ✈️ PAPER TREASURY SIMULATION prefix', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime();
    await generateMorningBriefing(rt);
    expect(rt._sentMessages[0]).toContain('✈️ PAPER TREASURY SIMULATION');
  });

  it('briefing message includes ✈️ PAPER TREASURY SIMULATION prefix', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime();
    await generateMorningBriefing(rt);
    // The second message is the full briefing
    expect(rt._sentMessages).toHaveLength(2);
    expect(rt._sentMessages[1]).toContain('✈️ PAPER TREASURY SIMULATION');
  });

  it('briefing message starts with ☀️ State of the Treasury', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime();
    await generateMorningBriefing(rt);
    // Strip prefix (first two lines + blank) and check briefing body starts with ☀️
    const briefingMsg = rt._sentMessages[1]!;
    expect(briefingMsg).toContain('☀️ State of the Treasury');
  });

  it('sends fallback briefing (no crash) when useModel throws', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime(new Error('Qwen unavailable'));
    await expect(generateMorningBriefing(rt)).resolves.toBeUndefined();
    expect(rt._sentMessages).toHaveLength(2);
  });

  it('fallback briefing includes portfolio positions and yield rates', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    getSnapshotSpy.mockReturnValue([
      { id: 1, protocol: 'Kamino', symbol: 'USDC', amount_usd: 5000, percentage: 50, last_updated: '' },
    ]);
    const rt = makeMockRuntime(new Error('Qwen unavailable'));
    await generateMorningBriefing(rt);
    const fallbackMsg = rt._sentMessages[1]!;
    // Should contain portfolio info
    expect(fallbackMsg).toContain('Kamino');
    // Should contain yield rates
    expect(fallbackMsg).toContain('7.25');
    // Should contain Nostra sign-off
    expect(fallbackMsg).toContain('🫡 Nostra');
  });

  it('sends fallback briefing when yield provider throws before LLM generation', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    yieldGetSpy.mockRejectedValue(new Error('Yield provider unavailable'));
    const rt = makeMockRuntime();

    await expect(generateMorningBriefing(rt)).resolves.toBeUndefined();

    expect(rt._sentMessages).toHaveLength(2);
    expect(rt._sentMessages[1]).toContain('AI briefing unavailable');
    expect(rt._sentMessages[1]).toContain('yield data temporarily unavailable');
  });

  it('falls back when LLM briefing body is outside the 100-200 word range', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime(makeWordyBriefing(40));

    await expect(generateMorningBriefing(rt)).resolves.toBeUndefined();

    expect(rt._sentMessages).toHaveLength(2);
    expect(rt._sentMessages[1]).toContain('AI briefing unavailable');
    expect(rt._sentMessages[1]).toContain('Yield Landscape');
  });
});
